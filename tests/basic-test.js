const test = require('ava');
const fs = require('fs');
const percollate = require('..');

const testUrl = 'https://de.wikipedia.org/wiki/JavaScript';
const testPdf = `${__dirname}/test.pdf`;
const testHtml = `${__dirname}/test.html`;
const testEpub = `${__dirname}/test.epub`;
const testMd = `${__dirname}/test.md`;
const testWebtoHtml = `${__dirname}/testWebToHtml.html`;
const testHtmltoPdf = `${__dirname}/testHtmlToPdf.pdf`;

async function generateTestFiles() {
	await percollate.pdf(['https://de.wikipedia.org/wiki/JavaScript'], {
		output: testPdf,
		sandbox: false
	});
	await percollate.html(['https://de.wikipedia.org/wiki/JavaScript'], {
		output: testHtml,
		sandbox: false
	});
	await percollate.epub(['https://de.wikipedia.org/wiki/JavaScript'], {
		output: testEpub,
		sandbox: false
	});
	await percollate.md(['https://de.wikipedia.org/wiki/JavaScript'], {
		output: testMd,
		sandbox: false
	});
}

test.beforeEach(async () => {
	percollate.configure();
	await generateTestFiles();
});

test('files exists', async t => {
	t.true(fs.existsSync(testPdf));
	t.true(fs.existsSync(testHtml));
	t.true(fs.existsSync(testEpub));
	t.true(fs.existsSync(testMd));
	t.pass();
});

test('website to html & html to pdf', async t => {
	await percollate.html([testUrl], {
		output: testWebtoHtml,
		sandbox: false
	});
	await percollate.pdf([testWebtoHtml], {
		output: testHtmltoPdf,
		sandbox: false
	});
	t.pass();
});
