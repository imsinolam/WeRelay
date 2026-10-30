export const MESSAGE_BUBBLE_JS = String.raw`
function createMessageBubble(options) {
  var document = options.document;
  var text = options.text || createChatText();
  var escapeHtml = text.escapeHtml;
  var actions = options.actions || {};
  function renderMessageImages(message) {
    var images = Array.isArray(message && message.images) ? message.images : [];
    var visibleImages = images.map(function (image) {
      var url = typeof image.previewUrl === "string" && image.previewUrl
        ? image.previewUrl
        : typeof image.url === "string"
          ? image.url
          : "";
      if (!url) return "";
      var alt = image.alt || image.fileName || (message.pending ? "待发送图片" : "生成图片");
      return '<button class="message-image-button" type="button" data-open-image="' +
        escapeHtml(url) + '" data-image-alt="' + escapeHtml(alt) + '" aria-label="打开图片：' +
        escapeHtml(alt) + '"><img src="' + escapeHtml(url) + '" alt="' + escapeHtml(alt) +
        '" loading="lazy" decoding="async"><span class="message-image-error">图片加载失败，请刷新后重试</span></button>';
    }).filter(Boolean);
    return visibleImages.length
      ? '<div class="message-images' + (visibleImages.length === 1 ? " single" : "") + '">' +
        visibleImages.join("") + "</div>"
      : "";
  }

  function bindMessageImageActions(row) {
    row.querySelectorAll("[data-open-image]").forEach(function (button) {
      var image = button.querySelector("img");
      if (image) image.addEventListener("error", function () {
        button.classList.add("failed");
        button.disabled = true;
        button.removeAttribute("data-open-image");
      });
      button.addEventListener("click", function () {
        if (actions.onOpenImage) actions.onOpenImage(button.dataset.openImage, button.dataset.imageAlt);
      });
    });
  }

  function render(view) {
    var message = view.message;
    var row = document.createElement("article");
    var role = ["user", "assistant", "task"].includes(message.role) ? message.role : "assistant";
    row.className = "message-row " + role + (message.phase === "commentary" ? " commentary" : "") +
      (view.continues ? " continues" : "") + (message.pending ? message.status === "failed" ? " failed" : " pending" : "");
    row.id = view.id;
    var delivery = view.delivery;
    var deliveryHtml = delivery ? '<div class="message-delivery ' + (delivery.failed ? 'failed' : '') + '"><span>' +
      escapeHtml(delivery.text) + '</span>' +
      (delivery.copy ? '<button class="message-retry" type="button" data-copy-message="' + escapeHtml(message.clientId) + '">复制消息</button>' : '') +
      (delivery.retryLabel ? '<button class="message-retry" type="button" data-retry="' + escapeHtml(message.clientId) + '">' + escapeHtml(delivery.retryLabel) + '</button>' : '') + '</div>' : '';
    var footer = view.footer || {};
    var source = message.sourceTask || {};
    row.innerHTML = '<div class="message-card">' +
      (view.sourceLabel ? '<div class="message-source-task" data-source-adapter="' + escapeHtml(source.adapter) + '" data-source-session="' + escapeHtml(source.sessionId) + '">' + escapeHtml(view.sourceLabel) + '</div>' : '') +
      renderMessageImages(message) +
      (view.text ? '<div class="message-content">' + text.renderMarkdown(view.text, row.id) + '</div>' : '') +
      (footer.model ? '<div class="message-model">' + escapeHtml(footer.model) + '</div>' : '') +
      (footer.time ? '<div class="message-time">' + escapeHtml(footer.time) + '</div>' : '') + deliveryHtml + '</div>';
    var retry = row.querySelector('[data-retry]');
    if (retry) retry.addEventListener('click', function () { if (actions.onRetry) actions.onRetry(message.clientId); });
    var copy = row.querySelector('[data-copy-message]');
    if (copy) copy.addEventListener('click', function () { if (actions.onCopy) actions.onCopy(message.text); });
    bindMessageImageActions(row);
    return row;
  }
  return { render: render, renderImages: renderMessageImages, bindImageActions: bindMessageImageActions };
}
`;
