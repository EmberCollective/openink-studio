// Explicit completion keeps the unloaded-image confirmation guard testable.
export function installPaperImageMock(window) {
  const pending = [];
  globalThis.Image = class {
    naturalWidth = 1200;
    naturalHeight = 1800;
    set src(value) { this.source = value; pending.push(this); }
  };
  globalThis.__loadPaperImages = () => {
    for (const image of pending.splice(0)) image.onload?.();
  };
  window.SVGSVGElement.prototype.getScreenCTM = function () {
    if (this.getAttribute('aria-label') !== '背景四角调整') return null;
    return {a: .5, b: 0, c: 0, d: .5, e: 0, f: 0};
  };
}
