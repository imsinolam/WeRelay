/** Browser-side factory. No taskboard state, storage or network dependencies. */
export const CHAT_TEXT_JS = String.raw`
function createChatText(options) {
  options = options || {};
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderMessageLink(target, label) {
    var resolved = options.resolveLink ? options.resolveLink(target) : { href: target };
    var href = resolved && resolved.href || target;
    if (/^\s*(?:javascript|data|vbscript):/i.test(href)) return escapeHtml(label);
    return '<a href="' + escapeHtml(href) + '" target="_blank" rel="noreferrer"' +
      (resolved && resolved.localPreview ? ' data-local-preview="true"' : '') + '>' + escapeHtml(label) + '</a>';
  }

  function renderInline(value) {
    var source = String(value || "");
    var links = [];
    function preserveLink(target, label) {
      var token = "@@DESKRELAY_LINK_" + links.length + "@@";
      links.push(renderMessageLink(target, label));
      return token;
    }
    source = source.replace(/\[([^\]]+)\]\(((?:(?:https?|file):\/\/|\/(?!\/)|[A-Za-z]:[\\/])[^)\s]+)\)/gi, function (_, label, target) {
      return preserveLink(target, label);
    });
    source = source.replace(/(^|[\s:：(（\[【>])((?:https?|file):\/\/[a-zA-Z0-9\-._~:/?#\[\]@!$&'()*+,;%=]+)/gi, function (_, prefix, rawUrl) {
      var trail = "";
      var m = rawUrl.match(/([,.:;!?)]+)$/);
      var url = rawUrl;
      if (m) {
        trail = m[1];
        url = rawUrl.slice(0, rawUrl.length - trail.length);
      }
      return prefix + preserveLink(url, url) + trail;
    });
    var escaped = escapeHtml(source);
    escaped = escaped.replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>");
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    links.forEach(function (link, index) {
      escaped = escaped.replace("@@DESKRELAY_LINK_" + index + "@@", link);
    });
    return escaped;
  }

  function renderTextBlock(text) {
    var lines = text.split("\n");
    var html = [];
    var paragraph = [];
    var listType = "";

    function flushParagraph() {
      if (!paragraph.length) return;
      html.push("<p>" + paragraph.map(renderInline).join("<br>") + "</p>");
      paragraph = [];
    }
    function closeList() {
      if (!listType) return;
      html.push("</" + listType + ">");
      listType = "";
    }

    lines.forEach(function (line) {
      var heading = line.match(/^(#{1,3})\s+(.+)$/);
      var unordered = line.match(/^\s*[-*]\s+(.+)$/);
      var ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
      var quote = line.match(/^>\s?(.*)$/);
      if (!line.trim()) {
        flushParagraph();
        closeList();
        return;
      }
      if (heading) {
        flushParagraph();
        closeList();
        var level = heading[1].length;
        html.push("<h" + level + ">" + renderInline(heading[2]) + "</h" + level + ">");
        return;
      }
      if (unordered || ordered) {
        flushParagraph();
        var nextList = unordered ? "ul" : "ol";
        if (listType !== nextList) {
          closeList();
          listType = nextList;
          html.push(nextList === "ol" ? '<ol start="' + ordered[1] + '">' : "<ul>");
        }
        var itemValue = ordered ? ' value="' + ordered[1] + '"' : "";
        var itemText = unordered ? unordered[1] : ordered[2];
        html.push("<li" + itemValue + ">" + renderInline(itemText) + "</li>");
        return;
      }
      if (quote) {
        flushParagraph();
        closeList();
        html.push("<blockquote>" + renderInline(quote[1]) + "</blockquote>");
        return;
      }
      if (/^---+$/.test(line.trim())) {
        flushParagraph();
        closeList();
        html.push("<hr>");
        return;
      }
      closeList();
      paragraph.push(line);
    });
    flushParagraph();
    closeList();
    return html.join("");
  }

  function isCommandCodeLanguage(lang) {
    return ["bash", "sh", "shell", "zsh", "fish", "console", "terminal"]
      .indexOf(String(lang || "").toLowerCase()) >= 0;
  }

  function renderMarkdown(text, foldPrefix) {
    var parts = String(text || "").split(/\x60\x60\x60/);
    var units = [];
    parts.forEach(function (part, index) {
      if (index % 2 === 1) {
        var newline = part.indexOf("\n");
        var info = newline >= 0 ? part.slice(0, newline).trim() : "";
        var lang = info.split(/\s+/)[0] || "";
        var code = newline >= 0 ? part.slice(newline + 1) : part;
        var normalizedCode = code.replace(/\n$/, "");
        var lineCount = normalizedCode ? normalizedCode.split("\n").length : 1;
        var isCommand = isCommandCodeLanguage(lang);
        var shouldFold = isCommand || lineCount > 6 || normalizedCode.length > 320;
        var codeHtml = "<pre><code>" + escapeHtml(normalizedCode) + "</code></pre>";
        if (!shouldFold) {
          units.push({ kind: "code", command: false, html: codeHtml });
          return;
        }
        var amount = lineCount > 1 ? lineCount + " 行" : normalizedCode.length + " 字";
        var foldKey = String(foldPrefix || "message") + ":" + index;
        var title = isCommand ? "命令 · " + amount : "代码 / 输出 · " + amount;
        units.push({
          kind: "code",
          command: isCommand,
          html: '<details class="message-code-fold" data-fold-key="' + escapeHtml(foldKey) + '"><summary>' +
            '<span>' + title + "</span>" +
            '<span class="message-code-fold-action"><span class="message-code-fold-closed">展开</span>' +
            '<span class="message-code-fold-open">收起</span></span></summary>' + codeHtml + "</details>"
        });
        return;
      }
      units.push({ kind: "text", html: renderTextBlock(part) });
    });
    // 命令类折叠默认收起；连续多条命令（中间只有很短、且后面还跟命令的
    // 连接文字）再合并进一个外层分组，避免一串 bash 折叠条目仍占满正文；
    // 收尾文字即使很短也保留在分组外，避免结论被折叠吞掉。
    var output = [];
    var group = null;
    var groupIndex = 0;
    function flushCommandGroup() {
      if (!group) return;
      if (group.commands <= 1) {
        output.push(group.items.join(""));
      } else {
        groupIndex += 1;
        var foldKey = String(foldPrefix || "message") + ":tools-" + groupIndex;
        output.push('<details class="message-tools-group" data-fold-key="' + escapeHtml(foldKey) + '"><summary>' +
          "<span>命令 / 工具 · " + group.commands + " 条</span>" +
          '<span class="message-code-fold-action"><span class="message-code-fold-closed">展开</span>' +
          '<span class="message-code-fold-open">收起</span></span></summary>' +
          '<div class="message-tools-group-items">' + group.items.join("") + "</div></details>");
      }
      group = null;
    }
    units.forEach(function (unit, index) {
      if (unit.kind === "code" && unit.command) {
        if (!group) group = { commands: 0, items: [] };
        group.commands += 1;
        group.items.push(unit.html);
        return;
      }
      if (unit.kind === "text" && group) {
        var bridgeText = unit.html.replace(/<[^>]*>/g, "").trim();
        var nextUnit = units[index + 1];
        var nextIsCommand = Boolean(
          nextUnit && nextUnit.kind === "code" && nextUnit.command
        );
        if (bridgeText.length <= 40 && nextIsCommand) {
          group.items.push(unit.html);
          return;
        }
      }
      flushCommandGroup();
      output.push(unit.html);
    });
    flushCommandGroup();
    return output.join("");
  }

  function partitionProgressItems(progressItems) {
    var items = Array.isArray(progressItems) ? progressItems.filter(Boolean) : [];
    var plans = items.filter(function (item) { return item.kind === "plan"; });
    var pinned = plans.length > 0 ? [plans[plans.length - 1]] : [];
    var activity = items.filter(function (item) { return item.kind !== "plan"; });
    var visibleSet = new Set(activity.filter(function (item) {
      return item.status !== "completed";
    }));
    activity.filter(function (item) {
      return item.status === "completed";
    }).slice(-3).forEach(function (item) {
      visibleSet.add(item);
    });
    return {
      pinned: pinned,
      hidden: activity.filter(function (item) { return !visibleSet.has(item); }),
      visible: activity.filter(function (item) { return visibleSet.has(item); })
    };
  }

  function renderProgressItemHtml(item, fallbackText) {
    var status = item && (item.status === "running" || item.status === "failed")
      ? item.status
      : "completed";
    return '<div class="run-progress-item ' + status + '">' +
      '<span class="run-progress-dot" aria-hidden="true"></span>' +
      '<span class="run-progress-text">' + escapeHtml(item && item.text || fallbackText || "正在处理") + "</span>" +
    "</div>";
  }

  function renderProgressList(document, progressItems, adapterLabel) {
    if (!Array.isArray(progressItems) || progressItems.length === 0) return null;
    var list = document.createElement("section");
    list.className = "run-progress";
    list.setAttribute("aria-label", (adapterLabel || "Agent") + " 处理进展");
    var groups = partitionProgressItems(progressItems);
    var hiddenHtml = groups.hidden.length > 0
      ? '<details class="run-progress-history"><summary><span>之前 ' + groups.hidden.length + ' 条进展</span>' +
        '<span class="run-progress-fold-action"><span class="run-progress-fold-closed">展开</span>' +
        '<span class="run-progress-fold-open">收起</span></span></summary>' +
        '<div class="run-progress-history-items">' + groups.hidden.map(function (item) { return renderProgressItemHtml(item, (adapterLabel || "Agent") + " 正在处理"); }).join("") + "</div></details>"
      : "";
    list.innerHTML = groups.pinned.map(function (item) { return renderProgressItemHtml(item, (adapterLabel || "Agent") + " 正在处理"); }).join("") + hiddenHtml +
      groups.visible.map(function (item) { return renderProgressItemHtml(item, (adapterLabel || "Agent") + " 正在处理"); }).join("");
    return list;
  }

  function renderPendingIndicator(document, label) {
    var row = document.createElement("div");
    row.className = "response-pending";
    row.setAttribute("role", "status");
    row.setAttribute("aria-label", label || "Agent 正在执行");
    row.innerHTML = '<span class="agent-planning-dots" aria-hidden="true"><span>·</span><span>·</span><span>·</span></span>';
    return row;
  }
  return { escapeHtml: escapeHtml, renderInline: renderInline, renderMarkdown: renderMarkdown, partitionProgressItems: partitionProgressItems, renderProgressItemHtml: renderProgressItemHtml, renderProgressList: renderProgressList, renderPendingIndicator: renderPendingIndicator };
}
`;
