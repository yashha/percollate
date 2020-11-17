const { JSDOM } = require('jsdom');
const Hyphenator = require('hyphenopoly');
const { textToLang } = require('./util/language');

const hyphenator = Hyphenator.config({
	sync: true,
	require: Hyphenator.supportedLanguages,
	defaultLanguage: 'en-us',
	minWordLength: 6,
	leftmin: 4,
	rightmin: 4
});
console.log(hyphenator);

function hyphenate(text, lang) {
	console.log(lang);
	if (hyphenator.get(lang)) {
		return hyphenator.get(lang)(text);
	}
	return hyphenator.get('en-us')(text);
}

function hyphenateText(text) {
	if (typeof text === 'string') {
		return hyphenate(text);
	}

	return undefined;
}

function hyphenateHtml(html) {
	const lang = textToLang(html);
	if (typeof html === 'string') {
		if (html.trim().startsWith('<')) {
			const fragment = JSDOM.fragment(html);
			const hyphenateNode = async nodeParam => {
				let node = nodeParam;
				for (node = node.firstChild; node; node = node.nextSibling) {
					if (node.nodeType === 3) {
						node.textContent = hyphenate(node.textContent, lang);
					} else {
						hyphenateNode(node);
					}
				}
			};
			hyphenateNode(fragment);
			return fragment.firstChild.outerHTML;
		}
		return hyphenate(html, lang);
	}
	return undefined;
}

module.exports = { hyphenateText, hyphenateHtml };