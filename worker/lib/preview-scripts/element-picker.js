(function () {
	var ideOrigin = (window.__PREVIEW_CONFIG && window.__PREVIEW_CONFIG.ideOrigin) || '*';
	var isEmbedded = window.parent !== window;
	if (!isEmbedded) {
		return;
	}

	var pickerActive = false;
	var pickerTarget = null;
	var highlightedTarget = null;
	var overlayRoot;
	var backdrop;
	var spotlight;
	var frame;
	var label;
	var cursorStyle;
	var lastPointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

	function applyStyles(element, styles) {
		for (var key in styles) {
			element.style[key] = styles[key];
		}
	}

	function ensureOverlay() {
		if (overlayRoot) {
			return;
		}

		overlayRoot = document.createElement('div');
		applyStyles(overlayRoot, {
			position: 'fixed',
			inset: '0',
			zIndex: '2147483646',
			pointerEvents: 'none',
			fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
		});

		backdrop = document.createElement('div');
		applyStyles(backdrop, {
			position: 'absolute',
			inset: '0',
			opacity: '0',
			transition: 'opacity 140ms ease-out',
			background:
				'radial-gradient(circle at 50% 50%, rgba(217,70,239,0.18) 0%, rgba(168,85,247,0.16) 18%, rgba(59,130,246,0.12) 34%, rgba(15,23,42,0.08) 52%, rgba(15,23,42,0.28) 100%)',
		});

		spotlight = document.createElement('div');
		applyStyles(spotlight, {
			position: 'absolute',
			width: '160px',
			height: '160px',
			borderRadius: '9999px',
			background: 'radial-gradient(circle, rgba(244,114,182,0.28) 0%, rgba(168,85,247,0.18) 48%, rgba(59,130,246,0) 75%)',
			transform: 'translate(-50%, -50%)',
		});

		frame = document.createElement('div');
		applyStyles(frame, {
			position: 'fixed',
			borderRadius: '18px',
			border: '2px solid rgba(255,255,255,0.95)',
			boxShadow: '0 0 0 1px rgba(244,114,182,0.25), 0 0 0 4px rgba(168,85,247,0.2), 0 12px 30px rgba(15,23,42,0.35)',
			background: 'linear-gradient(135deg, rgba(244,114,182,0.08), rgba(168,85,247,0.04), rgba(59,130,246,0.08))',
			transition: 'transform 100ms ease-out, opacity 120ms ease-out, width 120ms ease-out, height 120ms ease-out',
			transform: 'translate3d(0, 0, 0)',
			opacity: '0',
		});

		label = document.createElement('div');
		applyStyles(label, {
			position: 'fixed',
			display: 'inline-flex',
			alignItems: 'center',
			padding: '4px 8px',
			borderRadius: '9999px',
			border: '1px solid rgba(255,255,255,0.28)',
			background: 'rgba(15, 23, 42, 0.88)',
			color: '#f8fafc',
			fontSize: '11px',
			fontWeight: '700',
			letterSpacing: '0.01em',
			boxShadow: '0 8px 18px rgba(15,23,42,0.22)',
			opacity: '0',
			transform: 'translate3d(0, 0, 0)',
			maxWidth: 'min(180px, calc(100vw - 16px))',
			whiteSpace: 'nowrap',
			overflow: 'hidden',
			textOverflow: 'ellipsis',
		});

		cursorStyle = document.createElement('style');
		cursorStyle.textContent = 'html, body, body * { cursor: crosshair !important; }';

		overlayRoot.append(backdrop, spotlight, frame, label);
		(document.body || document.documentElement).appendChild(overlayRoot);
	}

	function setPickerCursor(isActive) {
		ensureOverlay();
		if (!cursorStyle) {
			return;
		}

		if (isActive) {
			if (!cursorStyle.isConnected) {
				(document.head || document.documentElement).appendChild(cursorStyle);
			}
			return;
		}

		cursorStyle.remove();
	}

	function escapeSelectorValue(value) {
		if (window.CSS && typeof window.CSS.escape === 'function') {
			return window.CSS.escape(value);
		}
		return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
	}

	function isUniqueSelector(selector) {
		try {
			return document.querySelectorAll(selector).length === 1;
		} catch {
			return false;
		}
	}

	function createAttributeSelector(element, attributeName) {
		var rawValue = element.getAttribute(attributeName);
		if (!rawValue) {
			return undefined;
		}

		var tagName = element.tagName.toLowerCase();
		var selector = tagName + '[' + attributeName + '="' + rawValue.replaceAll('"', '\\"') + '"]';
		return isUniqueSelector(selector) ? selector : undefined;
	}

	function getStableSelectorForElement(element) {
		if (element.id) {
			var idSelector = '#' + escapeSelectorValue(element.id);
			if (isUniqueSelector(idSelector)) {
				return idSelector;
			}
		}

		var attributeSelectors = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'aria-label', 'name', 'alt'];
		for (var attributeIndex = 0; attributeIndex < attributeSelectors.length; attributeIndex++) {
			var attributeSelector = createAttributeSelector(element, attributeSelectors[attributeIndex]);
			if (attributeSelector) {
				return attributeSelector;
			}
		}

		return undefined;
	}

	function getStructuralSelector(element) {
		var currentTagName = element.tagName.toLowerCase();
		var siblingIndex = 1;
		var sibling = element.previousElementSibling;
		while (sibling) {
			if (sibling.tagName === element.tagName) {
				siblingIndex += 1;
			}
			sibling = sibling.previousElementSibling;
		}
		return currentTagName + ':nth-of-type(' + siblingIndex + ')';
	}

	function buildElementSelector(element) {
		if (element === document.body) {
			return 'body';
		}

		var stableSelector = getStableSelectorForElement(element);
		if (stableSelector) {
			return stableSelector;
		}

		var path = [];
		var current = element;
		while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
			path.unshift(getStructuralSelector(current));

			var currentStableSelector = getStableSelectorForElement(current);
			if (currentStableSelector) {
				var anchoredSelector = currentStableSelector;
				if (path.length > 1) {
					anchoredSelector += ' > ' + path.slice(1).join(' > ');
				}
				if (isUniqueSelector(anchoredSelector)) {
					return anchoredSelector;
				}
			}

			var candidate = 'body > ' + path.join(' > ');
			if (isUniqueSelector(candidate)) {
				return candidate;
			}
			current = current.parentElement;
		}

		return path.length > 0 ? 'body > ' + path.join(' > ') : 'body';
	}

	function resolveCandidateTarget(node) {
		var element = node instanceof Element ? node : undefined;
		while (element && element !== overlayRoot) {
			var tagName = element.tagName.toLowerCase();
			if (
				tagName !== 'html' &&
				tagName !== 'script' &&
				tagName !== 'style' &&
				tagName !== 'link' &&
				tagName !== 'meta' &&
				tagName !== 'br'
			) {
				return element;
			}
			element = element.parentElement;
		}

		return document.body;
	}

	function getElementFromPoint(x, y) {
		var target = document.elementFromPoint(x, y);
		return resolveCandidateTarget(target);
	}

	function getActiveTarget() {
		return pickerActive ? pickerTarget : highlightedTarget;
	}

	function findElementBySelector(selector) {
		try {
			return selector ? resolveCandidateTarget(document.querySelector(selector)) : null;
		} catch {
			return null;
		}
	}

	function updateBackdrop() {
		if (!backdrop || !spotlight) {
			return;
		}

		spotlight.style.left = lastPointer.x + 'px';
		spotlight.style.top = lastPointer.y + 'px';
		backdrop.style.background =
			'radial-gradient(circle at ' +
			lastPointer.x +
			'px ' +
			lastPointer.y +
			'px, rgba(217,70,239,0.2) 0%, rgba(168,85,247,0.16) 16%, rgba(59,130,246,0.12) 32%, rgba(15,23,42,0.08) 54%, rgba(15,23,42,0.28) 100%)';
	}

	function renderOverlay() {
		ensureOverlay();
		updateBackdrop();
		setPickerCursor(pickerActive);

		var viewportPadding = 6;

		backdrop.style.opacity = pickerActive ? '1' : '0';
		spotlight.style.opacity = pickerActive ? '1' : '0';

		var target = getActiveTarget();
		if (!target || !document.contains(target)) {
			frame.style.opacity = '0';
			label.style.opacity = '0';
			return;
		}

		var rect = target.getBoundingClientRect();
		var frameLeft = Math.max(rect.left - 4, viewportPadding);
		var frameTop = Math.max(rect.top - 4, viewportPadding);
		var frameRight = Math.min(rect.right + 4, window.innerWidth - viewportPadding);
		var frameBottom = Math.min(rect.bottom + 4, window.innerHeight - viewportPadding);
		var frameWidth = Math.max(frameRight - frameLeft, 24);
		var frameHeight = Math.max(frameBottom - frameTop, 24);

		frame.style.opacity = '1';
		frame.style.left = frameLeft + 'px';
		frame.style.top = frameTop + 'px';
		frame.style.width = frameWidth + 'px';
		frame.style.height = frameHeight + 'px';

		label.textContent = '<' + target.tagName.toLowerCase() + '>';
		label.style.opacity = '1';

		var labelWidth = label.offsetWidth;
		var labelHeight = label.offsetHeight;
		var labelLeft = Math.min(Math.max(frameLeft + 8, viewportPadding), window.innerWidth - viewportPadding - labelWidth);
		var labelTop = frameTop > labelHeight + 14 ? frameTop - labelHeight - 8 : frameBottom + 8;
		labelTop = Math.min(Math.max(labelTop, viewportPadding), window.innerHeight - viewportPadding - labelHeight);

		label.style.left = labelLeft + 'px';
		label.style.top = labelTop + 'px';
	}

	function setPickerTargetFromPoint(x, y) {
		lastPointer = { x: x, y: y };
		pickerTarget = getElementFromPoint(x, y);
		renderOverlay();
	}

	function cancelPicker(notifyParent) {
		pickerActive = false;
		pickerTarget = null;
		renderOverlay();
		if (notifyParent) {
			window.parent.postMessage({ type: '__preview-element-picker-cancelled' }, ideOrigin);
		}
	}

	function selectTarget(target) {
		if (!target) {
			return;
		}

		var selector = buildElementSelector(target);
		pickerActive = false;
		pickerTarget = null;
		renderOverlay();
		window.parent.postMessage({ type: '__preview-element-picked', selector: selector, tagName: target.tagName.toLowerCase() }, ideOrigin);
	}

	function setHighlightedTarget(selector) {
		highlightedTarget = findElementBySelector(selector);
		renderOverlay();
		return !!highlightedTarget;
	}

	function revealHighlightedTarget(selector) {
		highlightedTarget = findElementBySelector(selector);
		if (highlightedTarget && typeof highlightedTarget.scrollIntoView === 'function') {
			highlightedTarget.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
		}
		renderOverlay();
		return !!highlightedTarget;
	}

	window.addEventListener(
		'pointermove',
		function (event) {
			if (!pickerActive) {
				return;
			}
			if (event.pointerType === 'touch') {
				event.preventDefault();
			}
			setPickerTargetFromPoint(event.clientX, event.clientY);
		},
		true,
	);

	window.addEventListener(
		'touchmove',
		function (event) {
			if (!pickerActive || !event.touches[0]) {
				return;
			}
			event.preventDefault();
			setPickerTargetFromPoint(event.touches[0].clientX, event.touches[0].clientY);
		},
		{ capture: true, passive: false },
	);

	window.addEventListener(
		'click',
		function (event) {
			if (!pickerActive) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			selectTarget(getElementFromPoint(event.clientX, event.clientY));
		},
		true,
	);

	window.addEventListener(
		'pointerdown',
		function (event) {
			if (!pickerActive) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			setPickerTargetFromPoint(event.clientX, event.clientY);
		},
		true,
	);

	window.addEventListener(
		'keydown',
		function (event) {
			if (!pickerActive) {
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				cancelPicker(true);
			}
		},
		true,
	);

	window.addEventListener(
		'scroll',
		function () {
			if (pickerActive || highlightedTarget) {
				renderOverlay();
			}
		},
		true,
	);

	window.addEventListener('resize', renderOverlay);

	window.addEventListener('message', function (event) {
		if (event.origin !== ideOrigin || !event.data || typeof event.data.type !== 'string') {
			return;
		}

		if (event.data.type === '__preview-element-picker-start') {
			pickerActive = true;
			pickerTarget = document.body;
			highlightedTarget = null;
			renderOverlay();
			return;
		}

		if (event.data.type === '__preview-element-picker-cancel') {
			cancelPicker(false);
			return;
		}

		if (event.data.type === '__preview-element-highlight' && typeof event.data.selector === 'string') {
			setHighlightedTarget(event.data.selector);
			return;
		}

		if (event.data.type === '__preview-element-reveal' && typeof event.data.selector === 'string') {
			revealHighlightedTarget(event.data.selector);
			return;
		}

		if (
			event.data.type === '__preview-element-resolve' &&
			typeof event.data.selector === 'string' &&
			typeof event.data.requestId === 'string'
		) {
			window.parent.postMessage(
				{ type: '__preview-element-resolved', requestId: event.data.requestId, found: !!findElementBySelector(event.data.selector) },
				ideOrigin,
			);
			return;
		}

		if (event.data.type === '__preview-element-highlight-clear') {
			highlightedTarget = null;
			renderOverlay();
		}
	});
})();
