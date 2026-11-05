const api = typeof browser !== "undefined" ? browser : chrome;
api.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === "extract-content") {
    const content = extractPageContent();
    sendResponse(content);
  }
  return true;
});
function extractPageContent() {
  var _a, _b;
  const title = document.title || "";
  const url = window.location.href;
  let text = "";
  const reader = document.querySelector("article, main, [role='main'], .content, #content, .post, .article");
  if (reader) {
    text = reader.innerText || reader.textContent || "";
  } else {
    text = ((_a = document.body) == null ? void 0 : _a.innerText) || ((_b = document.body) == null ? void 0 : _b.textContent) || "";
  }
  text = text.replace(/\s+/g, " ").trim();
  const maxLen = 8e3;
  if (text.length > maxLen) {
    text = text.substring(0, maxLen) + "...";
  }
  return { title, url, text };
}
