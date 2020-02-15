#!/usr/bin/env node
const pup = require('puppeteer');
const got = require('got');
const ora = require('ora');
const { JSDOM } = require('jsdom');
const nunjucks = require('nunjucks');
const tmp = require('tmp');
const fs = require('fs');
const css = require('css');
const slugify = require('slugify');
const Readability = require('./vendor/readability');
const pkg = require('./package.json');
const uuid = require('uuid/v1');
const TurndownService = require('turndown');
let Epub = require('epub-gen');

const spinner = ora();

const {
	ampToHtml,
	fixLazyLoadedImages,
	imagesAtFullSize,
	wikipediaSpecific,
	noUselessHref,
	relativeToAbsoluteURIs,
	singleImgToFigure,
	expandDetailsElements
} = require('./src/enhancements');
const get_style_attribute_value = require('./src/get-style-attribute-value');

const resolve = path =>
	require.resolve(path, {
		paths: [process.cwd(), __dirname]
	});

const enhancePage = function(dom) {
	// Note: the order of the enhancements matters!
	[
		ampToHtml,
		fixLazyLoadedImages,
		relativeToAbsoluteURIs,
		imagesAtFullSize,
		singleImgToFigure,
		noUselessHref,
		expandDetailsElements,
		wikipediaSpecific
	].forEach(enhancement => {
		enhancement(dom.window.document);
	});
};

function createDom({ url, content }) {
	const dom = new JSDOM(content, { url });

	// Force relative URL resolution
	dom.window.document.body.setAttribute(null, null);

	return dom;
}

/*
	Some setup
	----------
 */
function configure() {
	nunjucks.configure({ autoescape: false, noCache: true });
}

/*
	Fetch a web page and clean the HTML
	-----------------------------------
 */
async function cleanup(url, options) {
	try {
		spinner.start(`Fetching: ${url}`);
		/*
			Must ensure that the URL is properly encoded.
			See: https://github.com/danburzo/percollate/pull/83
		 */
		const content = (
			await got(encodeURI(decodeURI(url)), {
				headers: {
					'user-agent': `percollate/${pkg.version}`
				}
			})
		).body;
		spinner.succeed();

		spinner.start('Enhancing web page');
		const dom = createDom({ url, content });

		const amp = dom.window.document.querySelector('link[rel=amphtml]');
		if (amp && options.amp) {
			spinner.succeed('Found AMP version');
			return cleanup(amp.href, options);
		}

		/*
			Run enhancements
			----------------
		*/
		enhancePage(dom);

		// Run through readability and return
		const parsed = new Readability(dom.window.document, {
			classesToPreserve: [
				'no-href',

				/*
					Placed on some <a> elements
					as in-page anchors
				 */
				'anchor'
			]
		}).parse();

		spinner.succeed();
		return { ...parsed, id: `percollate-page-${uuid()}`, url };
	} catch (error) {
		spinner.fail(error.message);
		throw error;
	}
}

/*
	Bundle the HTML files into a PDF
	--------------------------------
 */
async function bundle(items, options) {
	spinner.start('Generating temporary HTML file');
	const temp_file = tmp.tmpNameSync({ postfix: '.html' });

	const stylesheet = resolve(options.style || './templates/default.css');
	const style = fs.readFileSync(stylesheet, 'utf8') + (options.css || '');
	const use_toc = options.toc && items.length > 1;

	const html = nunjucks.renderString(
		fs.readFileSync(
			resolve(options.template || './templates/default.html'),
			'utf8'
		),
		{
			items,
			style,
			stylesheet, // deprecated
			options: {
				use_toc
			}
		}
	);

	const doc = new JSDOM(html).window.document;
	const headerTemplate = doc.querySelector('.header-template');
	const footerTemplate = doc.querySelector('.footer-template');
	const header = new JSDOM(
		headerTemplate ? headerTemplate.innerHTML : '<span></span>'
	).window.document;
	const footer = new JSDOM(
		footerTemplate ? footerTemplate.innerHTML : '<span></span>'
	).window.document;

	const css_ast = css.parse(style);

	const header_style = get_style_attribute_value(css_ast, '.header-template');
	const header_div = header.querySelector('body :first-child');

	if (header_div && header_style) {
		header_div.setAttribute(
			'style',
			`
				${header_style};
				${header_div.getAttribute('style') || ''}
			`
		);
	}

	const footer_style = get_style_attribute_value(css_ast, '.footer-template');
	const footer_div = footer.querySelector('body :first-child');

	if (footer_div && footer_style) {
		footer_div.setAttribute(
			'style',
			`
				${footer_style};
				${footer_div.getAttribute('style') || ''}
			`
		);
	}

	fs.writeFileSync(temp_file, html);

	spinner.succeed(`Temporary HTML file: file://${temp_file}`);

	const browser = await pup.launch({
		headless: true,
		/*
			Allow running with no sandbox
			See: https://github.com/danburzo/percollate/issues/26
		 */
		args: options.sandbox
			? undefined
			: ['--no-sandbox', '--disable-setuid-sandbox'],
		defaultViewport: {
			// Emulate retina display (@2x)...
			deviceScaleFactor: 2,
			// ...but then we need to provide the other
			// viewport parameters as well
			width: 1920,
			height: 1080
		}
	});
	const page = await browser.newPage();

	/*
		Increase the navigation timeout to 2 minutes
		See: https://github.com/danburzo/percollate/issues/80
	 */
	page.setDefaultNavigationTimeout(120 * 1000);

	if (options.debug) {
		page.on('response', response => {
			spinner.succeed(`Fetched: ${response.url()}`);
		});
	}

	await page.goto(`file://${temp_file}`, { waitUntil: 'load' });

	/*
		When no output path is present,
		produce the file name from the web page title
		(if a single page was sent as argument),
		or a timestamped file (for the moment)
		in case we're bundling many web pages.
	 */
	const output_path =
		options.output ||
		(items.length === 1
			? `${slugify(items[0].title || 'Untitled page')}.pdf`
			: `percollate-${Date.now()}.pdf`);

	await page.pdf({
		path: output_path,
		preferCSSPageSize: true,
		displayHeaderFooter: true,
		headerTemplate: header.body.innerHTML,
		footerTemplate: footer.body.innerHTML,
		printBackground: true
	});

	await browser.close();

	spinner.succeed(`Saved PDF: ${output_path}`);
}

/*
	Bundle the HTML files into a EPUB
	--------------------------------
 */
async function bundleEpub(items, options) {
	const stylesheet = resolve(options.style || './templates/default.css');
	const style = fs.readFileSync(stylesheet, 'utf8') + (options.css || '');

	const html = nunjucks.renderString(
		fs.readFileSync(
			resolve(options.template || './templates/default.html'),
			'utf8'
		),
		{
			items,
			style,
			stylesheet // deprecated
		}
	);

	spinner.start('Saving EPUB');

	/*
		When no output path is present,
		produce the file name from the web page title
		(if a single page was sent as argument),
		or a timestamped file (for the moment)
		in case we're bundling many web pages.
	 */
	const output_path =
		options.output ||
		(items.length === 1
			? `${slugify(items[0].title || 'Untitled page')}.epub`
			: `percollate-${Date.now()}.epub`);

	let option = {
		title: items[0].title,
		content: [
			{
				data: html
			}
		]
	};

	new Epub(option, output_path);

	spinner.succeed(`Saved EPUB: ${output_path}`);
}

/*
	Bundle the HTML files into a HTML
	--------------------------------
 */
async function bundleHtml(items, options) {
	const stylesheet = resolve(options.style || './templates/default.css');
	const style = fs.readFileSync(stylesheet, 'utf8') + (options.css || '');

	const html = nunjucks.renderString(
		fs.readFileSync(
			resolve(options.template || './templates/default.html'),
			'utf8'
		),
		{
			items,
			style,
			stylesheet // deprecated
		}
	);

	spinner.start('Saving HTML');

	/*
		When no output path is present,
		produce the file name from the web page title
		(if a single page was sent as argument),
		or a timestamped file (for the moment)
		in case we're bundling many web pages.
	 */
	const output_path =
		options.output ||
		(items.length === 1
			? `${slugify(items[0].title || 'Untitled page')}.html`
			: `percollate-${Date.now()}.html`);

	fs.writeFile(output_path, html, function(err) {
		if (err) {
			return console.log(err);
		}

		// console.log("The file was saved!");
	});

	spinner.succeed(`Saved HTML: ${output_path}`);
}

/*
	Bundle the HTML files into a Markdown
	--------------------------------
 */
async function bundleMd(items, options) {
	const stylesheet = resolve(options.style || './templates/default.css');
	const style = fs.readFileSync(stylesheet, 'utf8') + (options.css || '');

	const html = nunjucks.renderString(
		fs.readFileSync(
			resolve(options.template || './templates/markdown.html'),
			'utf8'
		),
		{
			items,
			style,
			stylesheet // deprecated
		}
	);

	spinner.start('Saving HTML');

	const turndownService = new TurndownService();
	const markdown = turndownService.turndown(html);

	/*
		When no output path is present,
		produce the file name from the web page title
		(if a single page was sent as argument),
		or a timestamped file (for the moment)
		in case we're bundling many web pages.
	 */
	const output_path =
		options.output ||
		(items.length === 1
			? `${slugify(items[0].title || 'Untitled page')}.md`
			: `percollate-${Date.now()}.md`);

	fs.writeFile(output_path, markdown, function(err) {
		if (err) {
			return console.log(err);
		}

		// console.log("The file was saved!");
	});

	spinner.succeed(`Saved HTML: ${output_path}`);
}

/*
	Generate PDF
 */
async function pdf(urls, options) {
	if (!urls.length) return;
	let items = [];
	for (let url of urls) {
		let item = await cleanup(url, options);
		if (options.individual) {
			await bundle([item], options);
		} else {
			items.push(item);
		}
	}
	if (!options.individual) {
		await bundle(items, options);
	}
}

/*
	Generate EPUB
 */
async function epub(urls, options) {
	if (!urls.length) return;
	let items = [];
	for (let url of urls) {
		let item = await cleanup(url, options);
		if (options.individual) {
			await bundleEpub([item], options);
		} else {
			items.push(item);
		}
	}
	if (!options.individual) {
		await bundleEpub(items, options);
	}
}

/*
	Generate HTML
 */
async function html(urls, options) {
	if (!urls.length) return;
	let items = [];
	for (let url of urls) {
		let item = await cleanup(url, options);
		if (options.individual) {
			await bundleHtml([item], options);
		} else {
			items.push(item);
		}
	}
	if (!options.individual) {
		await bundleHtml(items, options);
	}
}

/*
	Generate Markdown
 */
async function md(urls, options) {
	if (!urls.length) return;
	let items = [];
	for (let url of urls) {
		let item = await cleanup(url, options);
		if (options.individual) {
			await bundleMd([item], options);
		} else {
			items.push(item);
		}
	}
	if (!options.individual) {
		await bundleMd(items, options);
	}
}

module.exports = { configure, pdf, epub, html, md };
