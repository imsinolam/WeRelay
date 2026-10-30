export const CHAT_COMPOSER_JS = String.raw`

function createChatComposer(root, options) {
  options = options || {};
  var document = root.ownerDocument;
  var window = document.defaultView;
  var requestAnimationFrame = window.requestAnimationFrame.bind(window);
  var cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  var performance = window.performance;
  var actions = options.actions || {};
  var escapeHtml = createChatText().escapeHtml;
  var listeners = [];
  var disposed = false;
  var resizeFrame = 0;
  function part(name) { return root.querySelector('[data-chat-part="' + name + '"]'); }
  var composerForm = root;
  var composerInput = part("composer-input");
  var composerImageInput = part("composer-image-input");
  var composerImageButton = part("composer-image-button");
  var composerQueue = part("composer-queue");
  var composerMedia = part("composer-media");
  var composerModelMenu = part("composer-model-menu");
  var composerSessionMenu = part("composer-session-menu");
  var sendButton = part("send-button");
  var sendRunningOrb = part("send-running-orb");
  var composerBeam = root.querySelector('[data-beam="composer"]');
  function on(element, type, callback) {
    element.addEventListener(type, callback);
    listeners.push(function () { element.removeEventListener(type, callback); });
  }
  // Rendered rows own their listeners: detached rows can be collected, and a
  // retained row must not call back into a host after this instance is destroyed.
  function onContent(element, type, callback) {
    element.addEventListener(type, function (event) { if (!disposed) callback(event); });
  }
  function resized() {
    if (resizeFrame || disposed) return;
    resizeFrame = requestAnimationFrame(function () {
      resizeFrame = 0;
      if (!disposed && actions.onResize) actions.onResize(root.offsetHeight);
    });
  }
  function resize() {
    composerInput.style.height = "auto";
    composerInput.style.height = Math.min(composerInput.scrollHeight, 168) + "px";
    resized();
  }
  function updateControl(kind, view) {
    var control = part("composer-" + kind + "-control");
    var button = part("composer-" + kind + "-button");
    var label = part("composer-" + kind + "-label");
    var menu = part("composer-" + kind + "-menu");
    control.hidden = !view.visible;
    label.textContent = view.label || "";
    button.classList.toggle("is-readonly", !view.canChange);
    button.classList.toggle("is-loading", Boolean(view.changing));
    button.setAttribute("aria-disabled", (view.canChange || view.retry) && !view.changing ? "false" : "true");
    button.title = view.title || "";
    menu.hidden = !view.visible || !view.open;
    button.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
    part("composer-settings-controls").hidden = part("composer-model-control").hidden && part("composer-session-control").hidden;
  }
  function closeMenu(kind) {
    part("composer-" + kind + "-menu").hidden = true;
    part("composer-" + kind + "-button").setAttribute("aria-expanded", "false");
  }
  function renderSession(view) {
    updateControl("session", view);
    var signature = JSON.stringify(view);
    if (composerSessionMenu.weRelayRenderSignature === signature) return;
    composerSessionMenu.weRelayRenderSignature = signature;
    composerSessionMenu.innerHTML = "";
    (view.groups || []).forEach(function (group) {
      var heading = document.createElement("div");
      heading.className = "composer-model-group";
      heading.textContent = group.label;
      composerSessionMenu.appendChild(heading);
      group.options.forEach(function (option) {
        composerSessionMenu.appendChild(createOption(option, {
          kind: group.kind, label: option.label || option.id,
          selected: Boolean(group.value) && option.id === group.value, disabled: group.disabled || view.changing || option.disabled,
          onSelect: function () { if (actions.onSettingSelect) actions.onSettingSelect(group.kind, option.id); }
        }));
      });
    });
  }
  function createOption(option, config) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "composer-model-option" +
      (config.kind === "permission" ? " composer-permission-option" : "");
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", config.selected ? "true" : "false");
    button.disabled = Boolean(config.disabled);
    var copy = document.createElement("span");
    copy.className = "composer-model-option-copy";
    var label = document.createElement("span");
    label.className = "composer-model-option-label";
    label.textContent = config.label;
    copy.appendChild(label);
    if (config.kind !== "reasoning" && option && option.description) {
      var description = document.createElement("span");
      description.className = "composer-model-option-description";
      description.textContent = option.description;
      copy.appendChild(description);
    }
    var check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    check.setAttribute("viewBox", "0 0 16 16");
    check.setAttribute("aria-hidden", "true");
    check.setAttribute("class", "composer-model-option-check");
    if (config.selected) {
      var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "m3.5 8.2 2.7 2.7 6.3-6.3");
      check.appendChild(path);
    }
    button.appendChild(copy);
    button.appendChild(check);
    if (!config.disabled && typeof config.onSelect === "function") {
      onContent(button, "click", config.onSelect);
    }
    return button;
  }

  function renderModel(view) {
    updateControl("model", view);
    var signature = JSON.stringify(view);
    if (composerModelMenu.weRelayRenderSignature === signature) return;
    composerModelMenu.weRelayRenderSignature = signature;
    composerModelMenu.innerHTML = "";
    if (!view.visible || !view.canChange) return;
    var options = view.options || [];
    var currentModel = view.value;
    var groupsMap = new Map();
    options.forEach(function (option) {
      var groupName = typeof option.group === "string" && option.group.trim() ? option.group.trim() : "";
      if (!groupsMap.has(groupName)) groupsMap.set(groupName, []);
      groupsMap.get(groupName).push(option);
    });
    var groupNames = Array.from(groupsMap.keys());
    var multiSource = groupNames.length > 1;

    function renderOptionButton(option) {
      return createOption(option, { label: option.label || option.id, selected: option.id === currentModel,
        disabled: view.changing, onSelect: function () { if (actions.onModelSelect) actions.onModelSelect(option.id); } });
    }

    if (multiSource) {
      if (view.activeGroup === null) {
        groupNames.forEach(function (groupName) {
          var groupOptions = groupsMap.get(groupName) || [];
          var activeOption = groupOptions.find(function (opt) { return opt.id === currentModel; });
          var button = document.createElement("button");
          button.type = "button";
          button.className = "composer-model-option";
          button.setAttribute("role", "menuitem");
          button.disabled = view.changing;
          var copy = document.createElement("span");
          copy.className = "composer-model-option-copy";
          var label = document.createElement("span");
          label.className = "composer-model-option-label";
          label.textContent = groupName || "默认来源";
          copy.appendChild(label);
          var desc = document.createElement("span");
          desc.className = "composer-model-option-description";
          desc.textContent = activeOption
            ? (activeOption.label || activeOption.id)
            : (groupOptions.length + " 个模型");
          copy.appendChild(desc);

          var chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          chevron.setAttribute("viewBox", "0 0 16 16");
          chevron.setAttribute("aria-hidden", "true");
          chevron.setAttribute("class", "composer-model-chevron composer-model-chevron-right");
          var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", "m4.5 6 3.5 3.5L11.5 6");
          chevron.appendChild(path);

          button.appendChild(copy);
          button.appendChild(chevron);
          onContent(button, "click", function () {
            if (actions.onModelGroup) actions.onModelGroup(groupName);
          });
          composerModelMenu.appendChild(button);
        });
      } else {
        var currentGroupName = view.activeGroup;
        var backButton = document.createElement("button");
        backButton.type = "button";
        backButton.className = "composer-model-back";
        backButton.innerHTML = '<svg class="composer-model-chevron composer-model-chevron-left" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6"/></svg><span>' + escapeHtml(currentGroupName || "默认来源") + ' (返回来源列表)</span>';
        onContent(backButton, "click", function () {
          if (actions.onModelGroup) actions.onModelGroup(null);
        });
        composerModelMenu.appendChild(backButton);

        var groupOptions = groupsMap.get(currentGroupName) || [];
        groupOptions.forEach(function (option) {
          composerModelMenu.appendChild(renderOptionButton(option));
        });
      }
    } else {
      var lastModelGroup;
      options.forEach(function (option) {
        var groupName = typeof option.group === "string" ? option.group.trim() : "";
        if (groupName && groupName !== lastModelGroup) {
          lastModelGroup = groupName;
          var heading = document.createElement("div");
          heading.className = "composer-model-group";
          heading.textContent = groupName;
          composerModelMenu.appendChild(heading);
        }
        composerModelMenu.appendChild(renderOptionButton(option));
      });
    }
  }
  function renderQueue(visibleMessages, view) {
    view = view || {};
    composerQueue.innerHTML = "";
    composerQueue.hidden = visibleMessages.length === 0;
    visibleMessages.forEach(function (message) {
      var item = document.createElement("div");
      item.className = "queued-followup";
      item.setAttribute("data-queued-message-id", message.id);
      var optimistic = Boolean(message.optimistic);
      var busy = view.busyId === message.id;
      if (optimistic) {
        item.classList.add("is-pending");
        item.setAttribute("aria-busy", "true");
      }

      var main = document.createElement("div");
      main.className = "queued-followup-main";
      var icon = document.createElement("span");
      icon.className = "queued-followup-icon";
      icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></svg>';
      var copy = document.createElement("div");
      copy.className = "queued-followup-copy";
      var textEl = document.createElement("div");
      textEl.className = "queued-followup-text";
      textEl.textContent = message.displayText || String(message.text || "").replace(/\s+/g, " ").trim() || (message.imageCount ? "图片 " + message.imageCount + " 张" : "（空消息）");
      copy.appendChild(textEl);
      var status = document.createElement("div");
      status.className = "queued-followup-status" + (optimistic ? " is-pending" : "");
      status.textContent = optimistic
        ? message.status === "queued" ? "已排队 · 正在同步待发送列表" : "正在加入待发送…"
        : busy
          ? "正在更新…"
          : "已排队 · 等待当前任务完成";
      copy.appendChild(status);
      if (Number(message.imageCount) > 0 && String(message.text || "").trim()) {
        var imageMeta = document.createElement("div");
        imageMeta.className = "queued-followup-images";
        imageMeta.textContent = "图片 " + Number(message.imageCount) + " 张";
        copy.appendChild(imageMeta);
      }

      var actionButtons = document.createElement("div");
      actionButtons.className = "queued-followup-actions";
      // 乐观条目（还没有原生队列 ID）也要能操作：删除=取消本地待发，
      // 编辑=取回输入框。此前三个按钮对乐观条目一律禁用，用户点击毫无反应。
      var actionBusy = Boolean(view.busyId);
      var terminal = message.status === "delivered" || message.status === "cancelled";
      var steer = document.createElement("button");
      steer.type = "button";
      steer.className = "queued-followup-action steer-action";
      // 引导需要原生队列 ID，乐观条目暂时不可用。
      steer.disabled = optimistic || actionBusy || terminal;
      steer.setAttribute("aria-label", "引导这条消息");
      steer.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h12M13 8l4 4-4 4"/></svg><span class="queued-followup-action-label steer-label">引导</span>';
      onContent(steer, "click", function () { if (actions.onQueueSteer) actions.onQueueSteer(message.id); });
      var edit = document.createElement("button");
      edit.type = "button";
      edit.className = "queued-followup-action";
      edit.disabled = actionBusy || terminal;
      edit.setAttribute("aria-label", "编辑这条消息");
      edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 19 3.5-.8L18 8.7 15.3 6 5.8 15.5 5 19Z"/><path d="m13.8 7.5 2.7 2.7"/></svg><span class="queued-followup-action-label">编辑</span>';
      onContent(edit, "click", function () {
        if (actions.onQueueEdit) actions.onQueueEdit(message);
      });
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "queued-followup-action";
      remove.disabled = actionBusy || terminal;
      remove.setAttribute("aria-label", "删除这条消息");
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>';
      onContent(remove, "click", function () { if (actions.onQueueDelete) actions.onQueueDelete(message.id); });
      if (busy) steer.setAttribute("aria-busy", "true");
      actionButtons.appendChild(steer);
      actionButtons.appendChild(edit);
      actionButtons.appendChild(remove);
      // Keep action icons visible while the native queue ID is being confirmed.

      main.appendChild(icon);
      main.appendChild(copy);
      main.appendChild(actionButtons);
      item.appendChild(main);

      composerQueue.appendChild(item);
    });
    resized();
  }
  function renderImages(images) {
    composerMedia.innerHTML = "";
    composerMedia.hidden = images.length === 0;
    images.forEach(function (image) {
      var item = document.createElement("div");
      item.className = "composer-media-item";
      var previewButton = document.createElement("button");
      previewButton.type = "button";
      previewButton.className = "composer-media-preview";
      previewButton.setAttribute("aria-label", "打开图片：" + image.fileName);
      onContent(previewButton, "click", function () {
        if (actions.onOpenImage) actions.onOpenImage(image.previewUrl, image.fileName);
      });
      var preview = document.createElement("img");
      preview.src = image.previewUrl;
      preview.alt = image.fileName;
      previewButton.appendChild(preview);
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "composer-media-remove";
      remove.setAttribute("aria-label", "移除图片");
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>';
      onContent(remove, "click", function () {
        if (actions.onImageRemove) actions.onImageRemove(image.id);
      });
      item.appendChild(previewButton);
      item.appendChild(remove);
      composerMedia.appendChild(item);
    });
    resized();
  }

  var composerOrbAnimation = (function () {
    var raf = 0;
    var running = false;
    var ctx = null;
    var size = 20;
    var dpr = 1;
    var reduced = Boolean(
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
    var preset = {
      speed: 1.95,
      count: 0.088,
      size: 1.9
    };
    var options = null;

    function paint(tSec) {
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size * dpr, size * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // The sphere is monochrome by design. Paint its light ink directly in
      // WeRelay green instead of reading pixels back every frame, which is
      // expensive on mobile Safari and unnecessary for a 20px animation.
      bootOrbFrame(ctx, size, tSec, true, options, [16, 163, 127]);
    }

    function loop() {
      if (disposed || document.hidden || !root.isConnected || !root.getClientRects().length) { stop(); return; }
      paint(performance.now() / 1000 * preset.speed);
      if (running) raf = requestAnimationFrame(loop);
    }

    function stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    function start() {
      if (!ctx || running || reduced || document.hidden || !root.isConnected || !root.getClientRects().length) return;
      running = true;
      raf = requestAnimationFrame(loop);
    }

    function setup() {
      if (!sendRunningOrb) return;
      size = Math.max(1, Number.parseFloat(window.getComputedStyle(sendRunningOrb).width) || 20);
      dpr = Math.min(2, window.devicePixelRatio || 1);
      sendRunningOrb.width = Math.round(size * dpr);
      sendRunningOrb.height = Math.round(size * dpr);
      ctx = sendRunningOrb.getContext ? sendRunningOrb.getContext("2d") : null;
      options = bootOrbScaleRadii(
        bootOrbScaleCounts(BOOT_ORB_BASE, preset.count),
        preset.size
      );
      if (!ctx) return;
      paint(0.6);
      if (sendButton.classList.contains("is-stop") && !reduced) start();
    }

    return {
      setup: setup,
      start: start,
      stop: stop,
      repaint: function () {
        if (!ctx) return;
        paint(0.6);
        if (!document.hidden) start();
      }
    };
  })();

  function composerActionState(input) {
    if (input.stopMode) return input.stopRequested ? "stopping" : "running";
    if (input.sending) return "pending";
    return "send";
  }

  function updateAction(view) {
    var stopMode = view.stopMode;
    var stopRequested = view.stopRequested;
    var composerAction = composerActionState(view);
    sendButton.dataset.state = composerAction;
    sendButton.classList.toggle("is-stop", composerAction !== "send");
    sendButton.setAttribute("aria-busy", composerAction === "pending" ? "true" : "false");
    if (composerAction === "running" || composerAction === "pending") composerOrbAnimation.start();
    else composerOrbAnimation.stop();
    sendButton.setAttribute(
      "aria-label",
      stopMode
        ? (stopRequested ? "正在停止" : "停止")
        : composerAction === "pending" ? "发送中" : "发送"
    );
    sendButton.disabled = Boolean(
      composerAction === "pending" || view.queueBusy || !view.enabled ||
      stopRequested ||
      (!stopMode && !view.hasContent)
    );
    if (composerBeam) composerBeam.toggleAttribute("data-active", Boolean(view.beamActive));
  }

  on(composerForm, "submit", function (event) {
    event.preventDefault();
    if (actions.onSubmit) actions.onSubmit(event);
  });
  on(composerInput, "input", function (event) { resize(); if (actions.onInput) actions.onInput(event); });
  on(composerInput, "keydown", function (event) {
    if (event.isComposing) return;
    if (event.key === "Escape" && actions.onEscape) actions.onEscape(event);
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      composerForm.requestSubmit();
    }
  });
  on(composerImageButton, "click", function () {
    if (!actions.canAttach || actions.canAttach()) composerImageInput.click();
  });
  on(composerImageInput, "change", function () {
    if ((!actions.canAttach || actions.canAttach()) && actions.onFiles) actions.onFiles(Array.from(composerImageInput.files || []));
    composerImageInput.value = "";
  });
  on(composerInput, "paste", function (event) {
    var clipboard = event.clipboardData;
    if (!clipboard) return;
    var files = Array.from(clipboard.files || []).filter(function (file) { return /^image\//.test(file.type); });
    if (!files.length) files = Array.from(clipboard.items || []).flatMap(function (item) {
      var file = item.kind === "file" && /^image\//.test(item.type) ? item.getAsFile() : null;
      return file ? [file] : [];
    });
    if (!files.length) return;
    if (actions.canAttach && !actions.canAttach()) return;
    event.preventDefault();
    var plainText = clipboard.getData("text/plain");
    if (plainText) {
      if (actions.onInsertText) actions.onInsertText(plainText);
      else {
        composerInput.setRangeText(plainText, composerInput.selectionStart, composerInput.selectionEnd, "end");
        resize();
        if (actions.onInput) actions.onInput(event);
      }
    }
    if (actions.onFiles) actions.onFiles(files);
  });
  ["model", "session"].forEach(function (kind) {
    on(part("composer-" + kind + "-button"), "click", function () { if (actions.onToggleMenu) actions.onToggleMenu(kind); });
  });
  on(document, "click", function (event) {
    ["model", "session"].forEach(function (kind) {
      var control = part("composer-" + kind + "-control");
      if (!control.contains(event.target) && !(event.composedPath && event.composedPath().includes(control))) {
        closeMenu(kind);
        if (actions.onCloseMenu) actions.onCloseMenu(kind);
      }
    });
  });
  on(document, "visibilitychange", function () {
    if (document.hidden) composerOrbAnimation.stop();
    else if (["running", "pending"].includes(sendButton.dataset.state)) composerOrbAnimation.start();
  });
  composerOrbAnimation.setup();
  return {
    root: root, part: part, resize: resize, renderQueue: renderQueue, renderImages: renderImages,
    renderModel: renderModel, renderSession: renderSession, updateAction: updateAction, closeMenu: closeMenu,
    getValue: function () { return composerInput.value; },
    setValue: function (value) { composerInput.value = value; resize(); },
    destroy: function () {
      disposed = true;
      listeners.forEach(function (remove) { remove(); });
      listeners = [];
      composerOrbAnimation.stop();
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      if (composerBeam) {
        composerBeam.toggleAttribute("data-active", false);
        composerBeam.toggleAttribute("data-fading", false);
      }
    }
  };
}
`;
