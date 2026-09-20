/**
 * Blood-splatter watermark (assets/blood-splatter.png) as a real <img>
 * element rather than a CSS background-image - browsers scale a large,
 * detail-heavy background-image less cleanly than an <img> at a steep
 * downscale ratio (the source is 1536x1024, shown at a small corner-
 * watermark size), which was reading as pixelated.
 *
 * Injected once per window open into .window-content (NOT the app's own
 * root element - see components/_chrome.scss for why: the root carries
 * Foundry's own required `position: fixed`, which an earlier version of
 * this code broke by injecting/positioning against it directly), ahead of
 * the content area's real children so it paints behind everything else -
 * call this from _onFirstRender (fires once when the window is newly
 * opened), NOT _onRender (fires on every content refresh, which would
 * otherwise either duplicate the element or require its own idempotency
 * guard on every pass).
 * @param {foundry.applications.api.ApplicationV2} app
 */
export function injectBloodSplatter(app) {
  const content = app.element?.querySelector(".window-content");
  if (!content || content.querySelector(":scope > .carl-splatter-crop")) return;

  const crop = document.createElement("div");
  crop.className = "carl-splatter-crop";

  const img = document.createElement("img");
  img.className = "carl-splatter-img";
  // No leading slash, matching every other .img reference in this system
  // (item.img, actor.img, etc.) - resolved relative to the client page's own
  // URL, not this file's location (unlike a CSS url(), which resolves
  // relative to the stylesheet itself - see components/_chrome.scss).
  img.src = "systems/carl-rpg/assets/blood-splatter.png";
  img.alt = "";
  img.setAttribute("aria-hidden", "true");

  crop.append(img);
  content.prepend(crop);
}
