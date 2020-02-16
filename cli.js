#!/usr/bin/env node
const program = require('commander');
const pkg = require('./package.json');

const { configure, pdf, epub, html, md } = require('.');

/*
	Some setup
	----------
 */
configure();

/*
	Command-Line Interface definition
	---------------------------------
 */

function withCommonOptions(cmd) {
	return cmd
		.option('-o, --output [output]', 'Path for the generated bundle')
		.option('--template [template]', 'Path to custom HTML template')
		.option('--style [stylesheet]', 'Path to custom CSS')
		.option('--css [style]', 'Additional CSS style')
		.option('--individual', 'Export each web page as an individual file')
		.option('--no-amp', "Don't prefer the AMP version of the web page")
		.option('--toc', 'Generate a Table of Contents')
		.option('--debug', 'Print more detailed information');
}

program.version(pkg.version);

withCommonOptions(program.command('pdf [urls...]'))
	.option('--no-sandbox', 'Passed to Puppeteer')
	.description('Bundle web pages as a PDF file')
	.action(pdf);

withCommonOptions(program.command('epub [urls...]'))
	.description('Bundle web pages as an EPUB file')
	.action(epub);

withCommonOptions(program.command('html [urls...]'))
	.description('Bundle web pages as a HTML file')
	.action(html);

withCommonOptions(program.command('md [urls...]'))
	.description('Bundle web pages as a Markdown file')
	.action(md);

// with_common_options(
// 	program.command('', 'default command', { isDefault: true })
// ).action(() => {
// 	program.outputHelp();
// });

program.on('--help', () => {
	// eslint-disable-next-line no-console
	console.log(`
Examples:

  Single web page to PDF:

    percollate pdf --output my.pdf https://example.com
  
  Several web pages to a single PDF:

    percollate pdf --output my.pdf https://example.com/1 https://example.com/2
  
  Custom page size and font size:
    
    percollate pdf --output my.pdf --css "@page { size: A3 landscape } html { font-size: 18pt }" https://example.com
	`);
});

program.parse(process.argv);

// Show help by default when no arguments provided
if (!program.args.length) {
	program.outputHelp();
}
