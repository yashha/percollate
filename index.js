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
const uuid = require('uuid').v1;
const TurndownService = require('turndown');
const Epub = require('epub-gen');
const franc = require('franc-all');
const iso6393 = require('iso-639-3');
const pkg = require('./package.json');
const Readability = require('./vendor/readability');

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
const getStyleAttributeValue = require('./src/get-style-attribute-value');

const resolve = path =>
	require.resolve(path, {
		paths: [process.cwd(), __dirname]
	});

function enhancePage(dom) {
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
}

const stringIsAValidUrl = string => {
	try {
		return Boolean(new URL(string));
	} catch (e) {
		return false;
	}
};

function createDom({ url, content }) {
	// When you process a local file there may be no url
	const dom = stringIsAValidUrl(url)
		? new JSDOM(content, { url })
		: new JSDOM(content);

	// Force relative URL resolution
	dom.window.document.body.setAttribute(null, null);

	return dom;
}

function textToLang(text) {
	const franLanguage = franc(text);
	let lang = 'en';
	iso6393.forEach(language => {
		if (language.iso6393 === franLanguage) {
			lang = language.iso6391;
		}
	});
	return lang;
}

/*
	Some setup
	----------
 */
function configure() {
	nunjucks.configure({ autoescape: false, noCache: true });
}

async function fetchUrl(url) {
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
	return content;
}

/*
	Fetch a web page and clean the HTML
	-----------------------------------
 */
async function cleanup(url, options) {
	try {
		let content = '';
		const validatedUrl = stringIsAValidUrl(url) ? url : null;
		if (stringIsAValidUrl(url)) {
			content = await fetchUrl(url);
		} else {
			content = await fs.promises.readFile(url, 'utf8');
		}

		spinner.start('Enhancing web page');
		const dom = createDom({ url: validatedUrl, content });

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
		return {
			...parsed,
			id: `percollate-page-${uuid()}`,
			parsedUrl: validatedUrl
		};
	} catch (error) {
		spinner.fail(error.message);
		throw error;
	}
}

/*
	Bundle the HTML files into a PDF
	--------------------------------
 */
async function bundlePdf(items, options) {
	spinner.start('Generating temporary HTML file');
	const tempFile = tmp.tmpNameSync({ postfix: '.html' });

	const stylesheet = resolve(options.style || './templates/default.css');
	const style = fs.readFileSync(stylesheet, 'utf8') + (options.css || '');
	const useToc = options.toc && items.length > 1;
	const lang = textToLang(items[0].textContent);

	const renderedHtml = nunjucks.renderString(
		fs.readFileSync(
			resolve(options.template || './templates/default.html'),
			'utf8'
		),
		{
			items,
			style,
			lang,
			stylesheet, // deprecated
			options: {
				use_toc: useToc
			}
		}
	);

	const doc = new JSDOM(renderedHtml).window.document;
	const headerTemplate = doc.querySelector('.header-template');
	const footerTemplate = doc.querySelector('.footer-template');
	const header = new JSDOM(
		headerTemplate ? headerTemplate.innerHTML : '<span></span>'
	).window.document;
	const footer = new JSDOM(
		footerTemplate ? footerTemplate.innerHTML : '<span></span>'
	).window.document;

	const cssAst = css.parse(style);

	const headerStyle = getStyleAttributeValue(cssAst, '.header-template');
	const headerDiv = header.querySelector('body :first-child');

	if (headerDiv && headerStyle) {
		headerDiv.setAttribute(
			'style',
			`
				${headerStyle};
				${headerDiv.getAttribute('style') || ''}
			`
		);
	}

	const footerStyle = getStyleAttributeValue(cssAst, '.footer-template');
	const footerDiv = footer.querySelector('body :first-child');

	if (footerDiv && footerStyle) {
		footerDiv.setAttribute(
			'style',
			`
				${footerStyle};
				${footerDiv.getAttribute('style') || ''}
			`
		);
	}

	fs.writeFileSync(tempFile, renderedHtml);

	spinner.succeed(`Temporary HTML file: file://${tempFile}`);

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

	await page.goto(`file://${tempFile}`, { waitUntil: 'load' });

	/*
		When no output path is present,
		produce the file name from the web page title
		(if a single page was sent as argument),
		or a timestamped file (for the moment)
		in case we're bundling many web pages.
	 */
	const outputPath =
		options.output ||
		(items.length === 1
			? `${slugify(items[0].title || 'Untitled page')}.pdf`
			: `percollate-${Date.now()}.pdf`);

	await page.pdf({
		path: outputPath,
		preferCSSPageSize: true,
		displayHeaderFooter: true,
		headerTemplate: header.body.innerHTML,
		footerTemplate: footer.body.innerHTML,
		printBackground: true
	});

	await browser.close();

	spinner.succeed(`Saved PDF: ${outputPath}`);
}

/*
	Bundle the HTML files into a EPUB
	--------------------------------
 */
async function bundleEpub(items, options) {
	const stylesheet = resolve(options.style || './templates/default.css');
	const style = fs.readFileSync(stylesheet, 'utf8') + (options.css || '');

	const renderedHtml = nunjucks.renderString(
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
	const outputPath =
		options.output ||
		(items.length === 1
			? `${slugify(items[0].title || 'Untitled page')}.epub`
			: `percollate-${Date.now()}.epub`);

	const option = {
		title: items[0].title,
		content: [
			{
				data: renderedHtml
			}
		]
	};

	// eslint-disable-next-line no-new
	await new Epub(option, outputPath).promise;

	spinner.succeed(`Saved EPUB: ${outputPath}`);
}

/*
	Bundle the HTML files into a HTML
	--------------------------------
 */
async function bundleHtml(items, options) {
	const stylesheet = resolve(options.style || './templates/default.css');
	const style = fs.readFileSync(stylesheet, 'utf8') + (options.css || '');
	const lang = textToLang(items[0].textContent);

	const renderedHtml = nunjucks.renderString(
		fs.readFileSync(
			resolve(options.template || './templates/default.html'),
			'utf8'
		),
		{
			items,
			style,
			lang,
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
	const outputPath =
		options.output ||
		(items.length === 1
			? `${slugify(items[0].title || 'Untitled page')}.html`
			: `percollate-${Date.now()}.html`);

	fs.writeFile(outputPath, renderedHtml, err => {
		if (err) {
			// eslint-disable-next-line no-console
			console.log(err);
		}
	});

	spinner.succeed(`Saved HTML: ${outputPath}`);
}

/*
	Bundle the HTML files into a Markdown
	--------------------------------
 */
async function bundleMd(items, options) {
	const stylesheet = resolve(options.style || './templates/default.css');
	const style = fs.readFileSync(stylesheet, 'utf8') + (options.css || '');

	const renderedHtml = nunjucks.renderString(
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
	const markdown = turndownService.turndown(renderedHtml);

	/*
		When no output path is present,
		produce the file name from the web page title
		(if a single page was sent as argument),
		or a timestamped file (for the moment)
		in case we're bundling many web pages.
	 */
	const outputPath =
		options.output ||
		(items.length === 1
			? `${slugify(items[0].title || 'Untitled page')}.md`
			: `percollate-${Date.now()}.md`);

	fs.writeFile(outputPath, markdown, err => {
		if (err) {
			// eslint-disable-next-line no-console
			console.log(err);
		}
	});

	spinner.succeed(`Saved HTML: ${outputPath}`);
}

async function bundle(urls, options, bundleFunction) {
	if (!urls.length) return;
	const items = [];
	await Promise.all(
		urls.map(async url => {
			const item = await cleanup(url, options);
			if (options.individual) {
				await bundleFunction([item], options);
			} else {
				items.push(item);
			}
		})
	);
	if (!options.individual) {
		await bundleFunction(items, options);
	}
}

/*
	Generate PDF
 */
async function pdf(urls, options) {
	await bundle(urls, options, bundlePdf);
}

/*
	Generate EPUB
 */
async function epub(urls, options) {
	await bundle(urls, options, bundleEpub);
}

/*
	Generate HTML
 */
async function html(urls, options) {
	await bundle(urls, options, bundleHtml);
}

/*
	Generate Markdown
 */
async function md(urls, options) {
	await bundle(urls, options, bundleMd);
}

module.exports = { configure, pdf, epub, html, md };
