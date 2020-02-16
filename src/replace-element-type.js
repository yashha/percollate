/*
	Replace the element type (tag name) of an element.
	Does not copy over the children elements (yet).
 */
module.exports = function replaceElementType(el, type, doc) {
	if (el.parentNode) {
		const newEle = doc.createElement(type);
		el.attributes.forEach(attr => {
			newEle.setAttribute(attr.name, attr.value);
		});
		el.parentNode.replaceChild(newEle, el);
	}
};
