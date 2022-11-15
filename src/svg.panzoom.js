import {
	Svg,
	Matrix,
	extend,
	on,
	off,
	Box,
	Point,
	Container,
	Element,
	Runner,
	G,
} from "@svgdotjs/svg.js";

/**
 * @param {MouseEvent|TouchEvent} ev
 * @returns {TouchList|[{clientX:number,clientY:number}]}
 */
function normalizeEvent(ev) {
	return ev.touches || [{ clientX: ev.clientX, clientY: ev.clientY }];
}

/** @type {import('./svg.plugs').SvgPanZoomOptions} */
const defaultOptions = {
	performance: true,
	zoomSpeed: 2,
	zoomMin: Number.MIN_VALUE,
	zoomMax: Number.MAX_VALUE,
	zoomOnCtrl: true,
	enableWheelZoom: true,
	enablePinchZoom: true,
	enablePanning: true,
	panButton: 0,
	panByShift: true,
	oneFingerPan: false,
	margins: false,
	wheelZoomDeltaModeLinePixels: 17,
	wheelZoomDeltaModeScreenPixels: 53,
};

/**
 *
 * @param {SVGElement} el
 */
function setStyle(el) {
	el.style.transformOrigin = "0 0 0";
	// el.style.transition = '0.05s transform'
}

/**
 * 基于原库v2.1.2版本修改
 * https://github.com/svgdotjs/svg.panzoom.js
 * 把原来的函数形式封装为类
 */
export default class SvgPanZoom {
	/** @type {Svg} */
	svg;

	/** @type {import('./svg.plugs').SvgPanZoomOptions} */
	options;
	/** 原始参数 */
	original = {
		/** @type {Box} */
		viewbox: null,
		/** @type {Matrix} */
		matrix: null,
		transform: null,
		/** @type {Box} */
		agentBox: null,
	};
	eventTarget;

	/** @type {G} */
	panZoomAgent;
	/** @type {Matrix} */
	panZoomAgentTransform;
	panZoomAgentViewboxTransform;

	/** 是否处理正在缩放中 */
	isZooming = false;
	/** 是否处与拖动状态 */
	isPanning = false;
	/** 是否拖动了 */
	isPanStartEventEmited = false;

	bodyUserSelect;

	/** 当前缩放等级 */
	zoomLevel = 1;
	/** 实际缩放等级 */
	get scaleLevel() {
		return this.options.panZoomAgentOnly && this.panZoomAgent
			? this.panZoomAgentTransform.a
			: this.svg.zoom();
	}

	lasts = {
		point: null,
		touches: null,
		frameTimer: null,
	};

	viewbox;

	frames = [];

	// frameQueue = new Arraq()
	/**
	 *
	 * @param {Element} node
	 * @param {import('./svg.plugs').PanZoomOptions} options
	 */
	constructor(svg, options) {
		if (!svg) throw "svg is empty";

		this.options = Object.assign({ ...defaultOptions }, options);

		this.eventTarget = svg;
		this.svg = svg;

		if (this.svg.node.hasAttribute("viewBox")) {
			this.viewbox = this.original.viewbox = this.svg.viewbox();
		} else {
			this.viewbox = this.original.viewbox = this.svg.bbox();
		}

		if (this.options.panZoomAgent === true) {
			this.panZoomAgent = new G().addClass("svg-panzoom-agent");

			let childrens = this.svg.children();
			for (let chil of childrens) {
				if (/defs/.test(chil.type)) continue;

				this.panZoomAgent.put(chil);
			}
			this.svg.add(this.panZoomAgent);
		} else if (typeof this.options.panZoomAgent === "string") {
			let g = document.querySelector(this.options.panZoomAgent);
			if (g instanceof SVGGElement) {
				this.panZoomAgent = new G(g);
			}
		} else if (this.options.panZoomAgent instanceof G) {
			this.panZoomAgent = this.options.panZoomAgent;
		} else if (this.options.panZoomAgent instanceof SVGGElement) {
			this.panZoomAgent = new G(this.options.panZoomAgent);
		}

		if (this.panZoomAgent) {
			setStyle(this.panZoomAgent.node);
			// this.runner = this.panZoomAgent.animate()
			// this.runner.timeline().play()

			this.original.agentBox = this.panZoomAgent.bbox();

			if (this.options.removeViewbox) {
				this.original.matrix = new Matrix(this.panZoomAgent.node.getCTM());

				this.panZoomAgent.transform(this.original.matrix);
				this.svg.node.removeAttribute("viewBox");

				this.original.transform = this.panZoomAgent.transform();
			} else {
				this.original.transform = this.panZoomAgent.transform();
				this.original.matrix = this.panZoomAgent.matrixify();
			}

			this.panZoomAgentTransform = this.original.matrix.clone();

			if (this.options.panZoomAgentOnly) {
				let oldSvgZoom = this.svg.zoom,
					oldSvgPanTo = this.svg.panTo;

				this.svg.panTo = this.panTo.bind(this);
				this.svg.zoom = this.zoomTo.bind(this);
			}
		} else {
			setStyle(this.svg.node);
		}

		if (this.options.enableWheelZoom) {
			this.eventTarget.on("wheel.panZoom", this.handleWheelZoom, this, {
				passive: false,
			});
		}

		if (this.options.enablePinchZoom) {
			this.eventTarget.on(
				"touchstart.panZoom",
				this.handlePinchZoomStart,
				this,
				{ passive: false }
			);
		}

		if (this.options.enablePanning) {
			this.eventTarget.on("mousedown.panZoom", this.handlePanStart, this, {
				passive: false,
			});
		}
	}

	agentTransformToViewbox() {
		if (
			this.options.panZoomAgentOnly ||
			!this.panZoomAgent ||
			!this.panZoomAgentTransform
		)
			return;

		// 这里需要反转transform，因为坐标系是反的
		this.viewbox = this.viewbox.transform(this.panZoomAgentTransform.inverse());

		// 结束时，移除代理元素的transform属性
		this.panZoomAgent.node.removeAttribute("transform");
		this.panZoomAgentTransform = null;
		this.svg.node.setAttribute("viewBox", this.viewbox.toString());
	}

	restore(animate = true) {
		this.viewbox = new Box(this.original.viewbox);

		// this.transform = this.original.matrix.clone()
		// this.translateX = this.original.transform.translateX
		// this.translateY = this.original.transform.translateY

		this.update(animate);
		return this;
	}
	/**
	 * 缩放给定的差量
	 * @param {number|string} ratio 缩放倍数，0.8表示缩小20%，1.2表示放大20%
	 * @param {import('@svgdotjs/svg.js').CoordinateXY} focus
	 * @param {boolean|number} animate 是否动画过渡，传入number表示持续时间
	 * @returns
	 */
	zoom(ratio, focus, animate) {
		if (!ratio) return;

		let lvl = this.zoomLevel * ratio;
		if (lvl > this.options.zoomMax) {
			ratio = this.options.zoomMax / this.zoomLevel;
		} else if (lvl < this.options.zoomMin) {
			ratio = this.options.zoomMin / this.zoomLevel;
		}

		if (Math.abs(ratio - 1) <= 0.008) return;

		if (!focus) {
			focus = {
				x: this.original.viewbox.cx,
				y: this.original.viewbox.cy,
			};
		}

		if (
			this.panZoomAgent &&
			(this.isPanning || this.options.panZoomAgentOnly)
		) {
			// 在拖动时，如果有代理元素的时候不需要去计算viewbox
			this.panZoomAgentTransform.scaleO(ratio, focus.x, focus.y);
		} else {
			this.viewbox = this.svg
				.viewbox()
				.transform(new Matrix({ scale: 1 / ratio, origin: focus }));
		}

		this.zoomLevel *= ratio;

		this.update(animate);

		return this;
	}

	/**
	 * 重新实现svg实例的zoom方法（当仅使用代理元素时）
	 * @param {number} lvl
	 * @param {import('@svgdotjs/svg.js').CoordinateXY} focus
	 * @returns
	 */
	zoomTo(lvl, focus) {
		if (lvl == null) return this.zoomLevel;

		const viewbox = this.original.viewbox;

		let zoomDelta = lvl / this.zoomLevel;

		if (!focus) {
			focus = {
				x: viewbox.cx,
				y: viewbox.cy,
			};
		}
		let realFocus = new Point(focus).transform(this.panZoomAgentTransform);

		this.panZoomAgentTransform
			.translateO(viewbox.cx - realFocus.x, viewbox.cy - realFocus.y)
			.scaleO(zoomDelta, viewbox.cx, viewbox.cy);

		this.zoomLevel *= zoomDelta;

		this.panZoomAgent.node.setAttribute(
			"transform",
			this.panZoomAgentTransform.toString()
		);
	}
	/**
	 * 移动给定的偏移量
	 * @param {number} deltaX x轴偏移量，正数往右方移动
	 * @param {number} deltaY y轴偏移量，正数往下方移动
	 * @param {boolean|number} animate 是否动画过渡，传入number表示持续时间
	 * @returns
	 */
	pan(deltaX, deltaY, animate) {
		if (
			this.panZoomAgent &&
			(this.isPanning || this.options.panZoomAgentOnly)
		) {
			// 有代理元素的时候不需要去计算viewbox
			this.panZoomAgentTransform.translateO(deltaX, deltaY);
		} else {
			this.viewbox = this.viewbox.transform(
				new Matrix().translate(-deltaX, -deltaY)
			);
		}

		this.update(animate);
		return this;
	}

	/**
	 * 将指定坐标、元素移动到svg图的中心位置
	 * @param {Point|Element|import('@svgdotjs/svg.js').CoordinateXY} point 必须是Svg中的元素或svg的viewbox坐标系
	 * @param {number} zoomlvl 缩放等级
	 * @param {number} duration 动画的持续时间
	 * @returns
	 */
	panTo(point, zoomlvl, duration = 500) {
		if (typeof this.panTo.runner === "number") {
			window.cancelAnimationFrame(this.panTo.runner);
		} else if (this.panTo.runner instanceof Runner) {
			this.panTo.runner.finish();
		}
		this.panTo.runner = null;

		try {
			const viewbox = this.original.viewbox;

			/** @type{SvgElement} */
			let element;
			if (point instanceof Element) {
				element = point;

				// 拿到目标元素的盒子
				let elBox = element.bbox();

				// 将目标元素的中心店作为目标坐标
				point = {
					x: elBox.cx,
					y: elBox.cy,
				};

				if (zoomlvl === "auto") {
					// 长边占可视区域的10%
					zoomlvl =
						0.1 /
						Math.max(
							elBox.height / viewbox.height,
							elBox.width / viewbox.width
						);
				}
			} else if (point === "fit-center") {
				// 移动到svg图原始中心点
				point = {
					x: viewbox.cx,
					y: viewbox.cy,
				};
			}

			let zoomDelta = zoomlvl / this.zoomLevel,
				// 将g元素的transform变化到坐标后，就是新的坐标了
				realPoint = new Point(point).transform(this.panZoomAgentTransform);

			// 想要移到svg图中心位置，使用原始的viwbox中心点减去目标坐标点，就是偏移量了
			this.panZoomAgentTransform
				.translateO(viewbox.cx - realPoint.x, viewbox.cy - realPoint.y)
				.scaleO(zoomDelta, viewbox.cx, viewbox.cy);

			this.zoomLevel *= zoomDelta;
			if (duration > 16) {
				this.panTo.runner = this.panZoomAgent
					.animate(duration)
					.transform(this.panZoomAgentTransform);
			} else {
				// 无动画
				this.panZoomAgent.transform(this.panZoomAgentTransform);
			}

			return this;
		} catch (error) {
			console.error("[SVG] panTo出错: ", error);
		}
	}

	updateSync() {
		let actOnAgent =
			this.options.panZoomAgentOnly ||
			(this.panZoomAgent && this.isPanning && this.panZoomAgentTransform);

		if (actOnAgent) {
			this.panZoomAgent.attr(
				"transform",
				this.panZoomAgentTransform.toString()
			);
			return;
		}

		this.restrictToMargins(this.viewbox);
		this.svg.viewbox(viewbox);
	}
	update(animate = false) {
		let actOnAgent =
			(this.options.panZoomAgentOnly && this.panZoomAgent) ||
			(this.panZoomAgent && this.isPanning && this.panZoomAgentTransform);

		if (animate) {
			if (actOnAgent) {
				this.panZoomAgent.animate().transform(this.panZoomAgentTransform);
				return;
			}

			this.restrictToMargins(this.viewbox);
			this.svg.animate().viewbox(this.viewbox);
		} else {
			let doUpdate;
			if (actOnAgent) {
				let transform = this.panZoomAgentTransform.toString();
				doUpdate = () => {
					this.lasts.frameTimer = null;
					this.panZoomAgentTransform &&
						this.panZoomAgent.node.setAttribute("transform", transform);
				};
			} else {
				let viewbox = new Box(this.viewbox);
				this.restrictToMargins(viewbox);
				doUpdate = () => {
					this.lasts.frameTimer = null;
					this.svg.viewbox(viewbox);
				};
			}

			if (this.options.performance === false) {
				doUpdate();
			} else {
				if (this.lasts.frameTimer) {
					window.cancelAnimationFrame(this.lasts.frameTimer);
				}
				this.lasts.frameTimer = window.requestAnimationFrame(doUpdate);
			}
		}
	}
	updateByViewbox(viewbox) {
		if (this.panZoomAgent) return;

		this.restrictToMargins(viewbox);
		this.svg.viewbox(viewbox);
	}
	updateByTransform(transform) {
		if (this.panZoomAgent && transform) {
			this.panZoomAgent.node.setAttribute("transform", transform);
		}
	}
	/**
	 * 限制到一个盒子中
	 * @param {Box} box
	 * @returns
	 */
	restrictToMargins(box) {
		if (!this.options.margins) return box;
		const { top, left, bottom, right } = this.options.margins;

		const svg = this.svg;
		let viewbox = this.svg.viewbox();
		this.viewbox = viewbox;

		const { width, height } = svg.attr(["width", "height"]);
		const preserveAspectRatio = svg.node.preserveAspectRatio.baseVal;

		// The current viewport (exactly what is shown on the screen, what we ultimately want to restrict)
		// is not always exactly the same as current viewbox. They are different when the viewbox aspectRatio and the svg aspectRatio
		// are different and preserveAspectRatio is not "none". These offsets represent the difference in user coordinates
		// between the side of the viewbox and the side of the viewport.
		let viewportLeftOffset = 0;
		let viewportRightOffset = 0;
		let viewportTopOffset = 0;
		let viewportBottomOffset = 0;

		// preserveAspectRatio none has no offsets
		if (
			preserveAspectRatio.align !==
			preserveAspectRatio.SVG_PRESERVEASPECTRATIO_NONE
		) {
			const svgAspectRatio = width / height;
			const viewboxAspectRatio = viewbox.width / viewbox.height;
			// when aspectRatios are the same, there are no offsets
			if (viewboxAspectRatio !== svgAspectRatio) {
				// aspectRatio unknown is like meet because that's the default
				const isMeet =
					preserveAspectRatio.meetOrSlice !==
					preserveAspectRatio.SVG_MEETORSLICE_SLICE;
				const changedAxis =
					svgAspectRatio > viewboxAspectRatio ? "width" : "height";
				const isWidth = changedAxis === "width";
				const changeHorizontal = (isMeet && isWidth) || (!isMeet && !isWidth);
				const ratio = changeHorizontal
					? svgAspectRatio / viewboxAspectRatio
					: viewboxAspectRatio / svgAspectRatio;

				const offset = box[changedAxis] - box[changedAxis] * ratio;
				if (changeHorizontal) {
					if (
						preserveAspectRatio.align ===
							preserveAspectRatio.SVG_PRESERVEASPECTRATIO_XMIDYMIN ||
						preserveAspectRatio.align ===
							preserveAspectRatio.SVG_PRESERVEASPECTRATIO_XMIDYMID ||
						preserveAspectRatio.align ===
							preserveAspectRatio.SVG_PRESERVEASPECTRATIO_XMIDYMAX
					) {
						viewportLeftOffset = offset / 2;
						viewportRightOffset = -offset / 2;
					} else if (
						preserveAspectRatio.align ===
							preserveAspectRatio.SVG_PRESERVEASPECTRATIO_XMINYMIN ||
						preserveAspectRatio.align ===
							preserveAspectRatio.SVG_PRESERVEASPECTRATIO_XMINYMID ||
						preserveAspectRatio.align ===
							preserveAspectRatio.SVG_PRESERVEASPECTRATIO_XMINYMAX
					) {
						viewportRightOffset = -offset;
					} else if (
						preserveAspectRatio.align ===
							preserveAspectRatio.SVG_PRESERVEASPECTRATIO_XMAXYMIN ||
						preserveAspectRatio.align ===
							preserveAspectRatio.SVG_PRESERVEASPECTRATIO_XMAXYMID ||
						preserveAspectRatio.align ===
							preserveAspectRatio.SVG_PRESERVEASPECTRATIO_XMAXYMAX
					) {
						viewportLeftOffset = offset;
					}
				} else {
					if (
						preserveAspectRatio.align ===
							preserveAspectRatio.SVG_PRESERVEASPECTRATIO_XMINYMID ||
						preserveAspectRatio.align ===
							preserveAspectRatio.SVG_PRESERVEASPECTRATIO_XMIDYMID ||
						preserveAspectRatio.align ===
							preserveAspectRatio.SVG_PRESERVEASPECTRATIO_XMAXYMID
					) {
						viewportTopOffset = offset / 2;
						viewportBottomOffset = -offset / 2;
					} else if (
						preserveAspectRatio.align ===
							preserveAspectRatio.SVG_PRESERVEASPECTRATIO_XMINYMIN ||
						preserveAspectRatio.align ===
							preserveAspectRatio.SVG_PRESERVEASPECTRATIO_XMIDYMIN ||
						preserveAspectRatio.align ===
							preserveAspectRatio.SVG_PRESERVEASPECTRATIO_XMAXYMIN
					) {
						viewportBottomOffset = -offset;
					} else if (
						preserveAspectRatio.align ===
							preserveAspectRatio.SVG_PRESERVEASPECTRATIO_XMINYMAX ||
						preserveAspectRatio.align ===
							preserveAspectRatio.SVG_PRESERVEASPECTRATIO_XMIDYMAX ||
						preserveAspectRatio.align ===
							preserveAspectRatio.SVG_PRESERVEASPECTRATIO_XMAXYMAX
					) {
						viewportTopOffset = offset;
					}
				}
			}
		}

		// when box.x == leftLimit, the image is panned to the left,
		// i.e the current box is to the right of the initial viewbox,
		// and only the right part of the initial image is visible, i.e.
		// the right side of the initial viewbox minus left margin (viewbox.x+viewbox.width-left)
		// is aligned with the left side of the viewport (box.x + viewportLeftOffset):
		// viewbox.width + viewbox.x - left = box.x + viewportLeftOffset
		// viewbox.width + viewbox.x - left - viewportLeftOffset = box.x (= leftLimit)
		const leftLimit = viewbox.width + viewbox.x - left - viewportLeftOffset;
		// when box.x == rightLimit, the image is panned to the right,
		// i.e the current box is to the left of the initial viewbox
		// and only the left part of the initial image is visible, i.e
		// the left side of the initial viewbox plus right margin (viewbox.x + right)
		// is aligned with the right side of the viewport (box.x + box.width + viewportRightOffset)
		// viewbox.x + right = box.x + box.width + viewportRightOffset
		// viewbox.x + right - box.width - viewportRightOffset = box.x (= rightLimit)
		const rightLimit = viewbox.x + right - box.width - viewportRightOffset;
		// same with top and bottom
		const topLimit = viewbox.height + viewbox.y - top - viewportTopOffset;
		const bottomLimit = viewbox.y + bottom - box.height - viewportBottomOffset;

		box.x = Math.min(leftLimit, Math.max(rightLimit, box.x)); // enforce rightLimit <= box.x <= leftLimit
		box.y = Math.min(topLimit, Math.max(bottomLimit, box.y)); // enforce bottomLimit <= box.y <= topLimit
		return box;
	}

	/**
	 * 处理鼠标滚轮触发的zoom事件
	 * @param {WheelEvent} ev
	 * @returns
	 */
	handleWheelZoom(ev) {
		ev.preventDefault();

		if (this.options.zoomOnCtrl && ev.ctrlKey != true) return;
		// else if (this.options.panByShift) {
		//   if (ev.shiftKey) {
		//     this.handlePanStart.call(this, ev)
		//   }
		//   return
		// }

		let {
			zoomSpeed,
			wheelZoomDeltaModeLinePixels,
			wheelZoomDeltaModeScreenPixels,
		} = this.options;

		// When wheeling on a mouse,
		// - chrome by default uses deltaY = 53, deltaMode = 0 (pixel)
		// - firefox by default uses deltaY = 3, deltaMode = 1 (line)
		// - chrome and firefox on windows after configuring "One screen at a time"
		// use deltaY = 1, deltaMode = 2 (screen)
		//
		// Note that when when wheeling on a touchpad, deltaY depends on how fast
		// you swipe, but the deltaMode is still different between the browsers.
		//
		// Normalize everything so that isZooming speed is approximately the same in all cases
		let normalizedPixelDeltaY;
		switch (ev.deltaMode) {
			case 1:
				normalizedPixelDeltaY = ev.deltaY * wheelZoomDeltaModeLinePixels;
				break;
			case 2:
				normalizedPixelDeltaY = ev.deltaY * wheelZoomDeltaModeScreenPixels;
				break;
			default:
				// 0 (already pixels) or new mode (avoid crashing)
				normalizedPixelDeltaY = ev.deltaY;
				break;
		}

		let ratio = Math.pow(1 + zoomSpeed, (-1 * normalizedPixelDeltaY) / 100);
		const focusPoint = this.svg.point(ev.clientX, ev.clientY);

		if (!this.options.panZoomAgentOnly) {
			// 重新获取一次缩放等级，防止外部调用了svg的zoom方法
			this.zoomLevel = this.svg.zoom();
		}

		if (
			this.eventTarget.dispatch("zoom", {
				event: ev,
				level: this.zoomLevel * ratio,
				focus: focusPoint,
			}).defaultPrevented
		) {
			return this;
		}

		this.zoom(ratio, focusPoint);
	}

	/**
	 * 处理屏幕触摸缩放开始事件
	 * @param {TouchEvent} ev
	 * @returns
	 */
	handlePinchZoomStart(ev) {
		this.lasts.touches = normalizeEvent(ev);

		let { enablePanning, oneFingerPan } = this.options;

		// 开始平移，以防只有一个触摸被发现
		if (this.lasts.touches.length < 2) {
			if (enablePanning && oneFingerPan) {
				this.handlePanStart(ev);
			}
			return;
		}

		// Stop panning for more than one touch
		if (enablePanning && oneFingerPan) {
			this.handlePanStop(ev);
		}

		// We call it so late, so the user is still able to scroll / reload the page via gesture
		// In case oneFingerPan is not active
		ev.preventDefault();

		if (
			this.eventTarget.dispatch("pinchZoomStart", { event: ev })
				.defaultPrevented
		) {
			return;
		}

		this.eventTarget.off("touchstart.panZoom", this.handlePinchZoomStart);

		this.isZooming = true;

		if (this.panZoomAgent && !this.options.panZoomAgentOnly) {
			this.panZoomAgentTransform = new Matrix();
		} else {
			this.viewbox = this.svg.viewbox();
		}

		on(document, "touchmove.panZoom", this.handlePinchZoom, this, {
			passive: false,
		});
		on(document, "touchend.panZoom", this.handlePinchZoomStop, this, {
			passive: false,
		});
	}

	/**
	 * 处理屏幕触摸缩放结束事件
	 * @param {TouchEvent} ev
	 * @returns
	 */
	handlePinchZoomStop(ev) {
		ev.preventDefault();

		let { enablePanning, oneFingerPan } = this.options;

		const currentTouches = normalizeEvent(ev);
		if (currentTouches.length > 1) {
			return;
		}

		this.isZooming = false;

		this.eventTarget.dispatch("pinchZoomEnd", { event: ev });

		off(document, "touchmove.panZoom", this.handlePinchZoom);
		off(document, "touchend.panZoom", this.handlePinchZoomStop);
		this.eventTarget.on("touchstart.panZoom", this.handlePinchZoomStart, this);

		if (currentTouches.length && enablePanning && oneFingerPan) {
			this.handlePanStart(ev);
		}
	}

	/**
	 * 处理屏幕触摸缩放
	 * @param {TouchEvent} ev
	 */
	handlePinchZoom(ev) {
		const currentTouches = normalizeEvent(ev);

		// Distance Formula
		const lastDelta = Math.sqrt(
			Math.pow(
				this.lasts.touches[0].clientX - this.lasts.touches[1].clientX,
				2
			) +
				Math.pow(
					this.lasts.touches[0].clientY - this.lasts.touches[1].clientY,
					2
				)
		);

		const currentDelta = Math.sqrt(
			Math.pow(currentTouches[0].clientX - currentTouches[1].clientX, 2) +
				Math.pow(currentTouches[0].clientY - currentTouches[1].clientY, 2)
		);

		let zoomAmount = lastDelta / currentDelta;
		let zoomlvl = this.zoomLevel;

		if (
			(zoomlvl < this.options.zoomMin && zoomAmount > 1) ||
			(zoomlvl > this.options.zoomMax && zoomAmount < 1)
		) {
			zoomAmount = 1;
		}

		const currentFocus = {
			x:
				currentTouches[0].clientX +
				0.5 * (currentTouches[1].clientX - currentTouches[0].clientX),
			y:
				currentTouches[0].clientY +
				0.5 * (currentTouches[1].clientY - currentTouches[0].clientY),
		};

		const lastFocus = {
			x:
				this.lasts.touches[0].clientX +
				0.5 * (this.lasts.touches[1].clientX - this.lasts.touches[0].clientX),
			y:
				this.lasts.touches[0].clientY +
				0.5 * (this.lasts.touches[1].clientY - this.lasts.touches[0].clientY),
		};

		const p = this.svg.point(currentFocus.x, currentFocus.y);
		const focusP = this.svg.point(
			2 * currentFocus.x - lastFocus.x,
			2 * currentFocus.y - lastFocus.y
		);

		this.lasts.touches = currentTouches;

		this.eventTarget.dispatch("zoom", { box: box, focus: focusP });

		let transform = new Matrix()
			.translate(-focusP.x, -focusP.y)
			.scale(zoomAmount, 0, 0)
			.translate(p.x, p.y);

		if (this.panZoomAgent) {
			this.panZoomAgentTransform = this.panZoomAgentTransform.transform(
				transform.inverseO()
			);
		} else {
			this.viewbox = this.viewbox.transform(transform);
		}

		this.update();
	}

	/**
	 * 处理拖动开始事件
	 * @param {MouseEvent} ev
	 */
	async handlePanStart(ev) {
		const isMouse = ev.type.indexOf("mouse") > -1;
		// 以防用touch调用panStart
		if (
			isMouse &&
			ev.button !== this.options.panButton &&
			ev.which !== this.options.panButton + 1
		) {
			return;
		} else if (typeof this.options.beforePan === "function") {
			let reuslt = this.options.beforePan(ev);
			if (reuslt instanceof Promise) {
				reuslt = await reuslt;
			}
			if (!reuslt) {
				return;
			}
		}

		this.bodyUserSelect = document.body.style.userSelect;
		document.body.style.userSelect = this.bodyUserSelect;

		this.isPanStartEventEmited = false;

		// ev.preventDefault()

		this.eventTarget.off("mousedown.panZoom", this.handlePanStart);

		this.lasts.touches = normalizeEvent(ev);

		// 如果正处于缩放状态，则禁止pan
		if (this.isZooming) return;

		this.lasts.point = {
			x: this.lasts.touches[0].clientX,
			y: this.lasts.touches[0].clientY,
		};

		on(
			document,
			"touchmove.panZoom mousemove.panZoom",
			this.handlePanning,
			this,
			{
				passive: true,
			}
		);

		on(document, "touchend.panZoom mouseup.panZoom", this.handlePanStop, this, {
			passive: true,
		});
	}
	/**
	 *
	 * @param {MouseEvnet} ev
	 */
	handlePanStop(ev) {
		// ev.preventDefault()
		// ev.stopPropagation()

		// document.body.style.userSelect = this.bodyUserSelect
		this.lasts.point = null;

		// 建议在panStart、panEnd时不要设置class，或者影响元素的style，因为会导致主线程重新计算样式导致卡顿，
		// 找了半天的原因，我就说为啥用了g+transform+requestAnimationFrame还会在panEnd中卡顿一下
		// 可以取消注释下面这几行看看实际情况

		// this.eventTarget.removeClass('is-panning')
		// this.eventTarget.node.style.cursor = null
		// this.eventTarget.node.style.userSelect = null

		if (this.isPanStartEventEmited) {
			this.isPanning = false;
			this.isPanStartEventEmited = false;
			this.eventTarget.dispatch("panEnd", { event: ev });

			this.agentTransformToViewbox();
		}

		off(document, "touchmove.panZoom mousemove.panZoom", this.handlePanning);
		off(document, "touchend.panZoom mouseup.panZoom", this.handlePanStop);
		this.eventTarget.on("mousedown.panZoom", this.handlePanStart, this);

		console.log("panEnd", this.x, this.y);
	}
	/**
	 *
	 * @param {MouseEvnet} e
	 * @returns
	 */
	handlePanning(ev) {
		// ev.preventDefault()

		const currentTouches = normalizeEvent(ev);

		const currentP = {
			x: currentTouches[0].clientX,
			y: currentTouches[0].clientY,
		};

		const p1 = this.svg.point(this.lasts.point.x, this.lasts.point.y);

		const p2 = this.svg.point(currentP.x, currentP.y);

		const deltaP = [p2.x - p1.x, p2.y - p1.y];
		if (!deltaP[0] && !deltaP[1]) {
			return;
		}

		if (!this.isPanStartEventEmited) {
			/**
			 * 不要在handlePanStart中就抛出panStart事件！
			 * 那只是鼠标按下了，并没有进行任何对图形的拖动，实际上应该在第一次panning的时候抛出panStart事件
			 */
			this.isPanning = true;
			this.isPanStartEventEmited = true;

			this.eventTarget.dispatch("panStart", { event: ev });

			// 为什么要注释？见handlePanStop
			// this.eventTarget.addClass('is-panning')
			// this.eventTarget.node.style.cursor = 'grabbing'
			// this.eventTarget.node.style.userSelect = 'none'

			this.viewbox = this.svg.viewbox();

			if (this.panZoomAgent && !this.options.panZoomAgentOnly) {
				this.panZoomAgentTransform = new Matrix();
			}
		}

		document.getSelection()?.removeAllRanges();

		if (
			this.eventTarget.dispatch("panning", {
				event: ev,
				currentPoint: p2,
				lastPoint: p1,
			}).defaultPrevented
		) {
			return;
		}

		this.lasts.point = currentP;

		this.pan(deltaP[0], deltaP[1]);
	}
}

extend(Svg, {
	/**
	 *
	 * @param {*} node
	 * @param {*} options
	 * @this {Element}
	 */
	panZoom(options) {
		let panzoom = this.remember("panzoom");

		if (panzoom) {
			if (options === false) {
				panzoom.el.off(".panZoom");
				panzoom.eventTarget.off(".panZoom");
				this.remember("panzoom", null);
				panzoom = null;
			}
			panzoom.options = options;
		} else if (options) {
			panzoom = new SvgPanZoom(this, options);
			this.remember("panzoom", panzoom);
		}
		return this;
	},
});
