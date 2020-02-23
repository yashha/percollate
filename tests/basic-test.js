const test = require('ava');
const fs = require('fs');
const percollate = require('..');

test.beforeEach(() => {
	percollate.configure();
});

test('basic pdf generation', async t => {
	const fileName = `${__dirname}/test.pdf`;
	await percollate.pdf(['https://de.wikipedia.org/wiki/JavaScript'], {
		output: fileName,
		sandbox: false
	});
	t.true(fs.existsSync(fileName));
	t.pass();
});
