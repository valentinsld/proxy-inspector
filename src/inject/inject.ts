/**
 * inject.ts — Script injected into every proxied page.
 *
 * Provides:
 *  1. Element highlighting with a colored overlay + border
 *  2. Smooth scroll to highlighted element
 *  3. Inspector mode (hover to highlight, click to select)
 *  4. CSS-selector-based selection from parent window
 *  5. Communication via postMessage with the host page
 */

;(function () {
  // Prevent double-init
  if ((window as any).__PROXY_HIGHLIGHT_INIT__) return
  ;(window as any).__PROXY_HIGHLIGHT_INIT__ = true

  // ─── Configuration ──────────────────────────────────────────────────────

  interface HighlightConfig {
    borderColor: string
    borderWidth: number
    overlayColor: string
    scrollBehavior: ScrollBehavior
    scrollBlock: ScrollLogicalPosition
    labelBackground: string
    labelColor: string
  }

  const defaultConfig: HighlightConfig = {
    borderColor: "#FF4444",
    borderWidth: 3,
    overlayColor: "rgba(255, 68, 68, 0.12)",
    scrollBehavior: "smooth",
    scrollBlock: "center",
    labelBackground: "#FF4444",
    labelColor: "#FFFFFF",
  }

  let config: HighlightConfig = { ...defaultConfig }

  // ─── Overlay element management ─────────────────────────────────────────

  let overlayTop: HTMLDivElement | null = null
  let overlayBottom: HTMLDivElement | null = null
  let overlayLeft: HTMLDivElement | null = null
  let overlayRight: HTMLDivElement | null = null
  let borderTop: HTMLDivElement | null = null
  let borderBottom: HTMLDivElement | null = null
  let borderLeft: HTMLDivElement | null = null
  let borderRight: HTMLDivElement | null = null
  let labelEl: HTMLDivElement | null = null

  let currentTarget: Element | null = null
  let inspectorMode = false
  let animationFrameId: number | null = null

  function createOverlayElements() {
    if (overlayTop) return // already created

    const createDiv = (zIndex: number): HTMLDivElement => {
      const div = document.createElement("div")
      div.setAttribute("data-proxy-highlight", "true")
      div.style.cssText = `
        position: fixed;
        pointer-events: none;
        z-index: ${zIndex};
        transition: all 0.15s ease-out;
      `
      document.documentElement.appendChild(div)
      return div
    }

    // Dimmed overlays (4 rectangles around the target)
    overlayTop = createDiv(2147483640)
    overlayBottom = createDiv(2147483640)
    overlayLeft = createDiv(2147483640)
    overlayRight = createDiv(2147483640)
    ;[overlayTop, overlayBottom, overlayLeft, overlayRight].forEach((el) => {
      el.style.backgroundColor = config.overlayColor
    })

    // Borders (4 thin lines)
    borderTop = createDiv(2147483641)
    borderBottom = createDiv(2147483641)
    borderLeft = createDiv(2147483641)
    borderRight = createDiv(2147483641)
    ;[borderTop, borderBottom, borderLeft, borderRight].forEach((el) => {
      el.style.backgroundColor = config.borderColor
    })

    // Label
    labelEl = createDiv(2147483642)
    labelEl.style.cssText += `
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 2px;
      white-space: nowrap;
      color: ${config.labelColor};
      background: ${config.labelBackground};
      line-height: 1.4;
    `
  }

  function positionOverlay(rect: DOMRect) {
    if (!overlayTop) return

    const bw = config.borderWidth
    const vw = window.innerWidth
    const vh = window.innerHeight

    // Clamp rect to viewport
    const top = Math.max(0, rect.top)
    const left = Math.max(0, rect.left)
    const bottom = Math.min(vh, rect.bottom)
    const right = Math.min(vw, rect.right)
    const width = right - left
    const height = bottom - top

    // Top overlay (from top of viewport to top of element)
    overlayTop!.style.top = "0"
    overlayTop!.style.left = "0"
    overlayTop!.style.width = vw + "px"
    overlayTop!.style.height = top + "px"

    // Bottom overlay
    overlayBottom!.style.top = bottom + "px"
    overlayBottom!.style.left = "0"
    overlayBottom!.style.width = vw + "px"
    overlayBottom!.style.height = vh - bottom + "px"

    // Left overlay
    overlayLeft!.style.top = top + "px"
    overlayLeft!.style.left = "0"
    overlayLeft!.style.width = left + "px"
    overlayLeft!.style.height = height + "px"

    // Right overlay
    overlayRight!.style.top = top + "px"
    overlayRight!.style.left = right + "px"
    overlayRight!.style.width = vw - right + "px"
    overlayRight!.style.height = height + "px"

    // Borders
    borderTop!.style.top = top - bw + "px"
    borderTop!.style.left = left - bw + "px"
    borderTop!.style.width = width + bw * 2 + "px"
    borderTop!.style.height = bw + "px"

    borderBottom!.style.top = bottom + "px"
    borderBottom!.style.left = left - bw + "px"
    borderBottom!.style.width = width + bw * 2 + "px"
    borderBottom!.style.height = bw + "px"

    borderLeft!.style.top = top + "px"
    borderLeft!.style.left = left - bw + "px"
    borderLeft!.style.width = bw + "px"
    borderLeft!.style.height = height + "px"

    borderRight!.style.top = top + "px"
    borderRight!.style.left = right + "px"
    borderRight!.style.width = bw + "px"
    borderRight!.style.height = height + "px"

    // Label
    if (labelEl && currentTarget) {
      const tag = currentTarget.tagName.toLowerCase()
      const id = currentTarget.id ? `#${currentTarget.id}` : ""
      const classes = Array.from(currentTarget.classList)
        .slice(0, 3)
        .map((c) => `.${c}`)
        .join("")
      const dims = `${Math.round(rect.width)}×${Math.round(rect.height)}`
      labelEl.textContent = `${tag}${id}${classes} (${dims})`

      // Position label above or below the element
      const labelHeight = 20
      if (top > labelHeight + 4) {
        labelEl.style.top = top - labelHeight - 4 + "px"
      } else {
        labelEl.style.top = bottom + 4 + "px"
      }
      labelEl.style.left = Math.max(0, left) + "px"
    }
  }

  function showOverlay() {
    const els = [
      overlayTop,
      overlayBottom,
      overlayLeft,
      overlayRight,
      borderTop,
      borderBottom,
      borderLeft,
      borderRight,
      labelEl,
    ]
    els.forEach((el) => {
      if (el) el.style.display = "block"
    })
  }

  function hideOverlay() {
    const els = [
      overlayTop,
      overlayBottom,
      overlayLeft,
      overlayRight,
      borderTop,
      borderBottom,
      borderLeft,
      borderRight,
      labelEl,
    ]
    els.forEach((el) => {
      if (el) el.style.display = "none"
    })
  }

  // ─── Highlight an element ───────────────────────────────────────────────

  function highlightElement(
    el: Element | null,
    options?: { scroll?: boolean; color?: string },
  ) {
    createOverlayElements()

    if (!el) {
      hideOverlay()
      currentTarget = null
      stopTracking()
      return
    }

    // Update color if provided
    if (options?.color) {
      config.borderColor = options.color
      config.overlayColor = hexToRgba(options.color, 0.12)
      config.labelBackground = options.color
      ;[borderTop, borderBottom, borderLeft, borderRight].forEach((b) => {
        if (b) b.style.backgroundColor = config.borderColor
      })
      ;[overlayTop, overlayBottom, overlayLeft, overlayRight].forEach((o) => {
        if (o) o.style.backgroundColor = config.overlayColor
      })
      if (labelEl) labelEl.style.background = config.labelBackground
    }

    currentTarget = el
    const rect = el.getBoundingClientRect()
    positionOverlay(rect)
    showOverlay()
    startTracking()

    // Scroll into view
    if (options?.scroll !== false) {
      el.scrollIntoView({
        behavior: config.scrollBehavior,
        block: config.scrollBlock,
      })
      // Re-position after scroll animation
      setTimeout(() => {
        if (currentTarget === el) {
          positionOverlay(el.getBoundingClientRect())
        }
      }, 500)
    }

    // Notify parent
    notifyParent("element-highlighted", {
      selector: getUniqueSelector(el),
      tagName: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: Array.from(el.classList),
      rect: {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      },
      text: (el.textContent || "").trim().substring(0, 200),
    })
  }

  // ─── Track position (for scrolling / resizing) ─────────────────────────

  function startTracking() {
    stopTracking()
    const track = () => {
      if (currentTarget) {
        positionOverlay(currentTarget.getBoundingClientRect())
      }
      animationFrameId = requestAnimationFrame(track)
    }
    animationFrameId = requestAnimationFrame(track)
  }

  function stopTracking() {
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
  }

  // ─── Inspector mode (hover & click) ─────────────────────────────────────

  function enableInspector() {
    if (inspectorMode) return
    inspectorMode = true
    document.addEventListener("mousemove", onInspectorMove, true)
    document.addEventListener("click", onInspectorClick, true)
    document.body.style.cursor = "crosshair"
    notifyParent("inspector-mode", { enabled: true })
  }

  function disableInspector() {
    if (!inspectorMode) return
    inspectorMode = false
    document.removeEventListener("mousemove", onInspectorMove, true)
    document.removeEventListener("click", onInspectorClick, true)
    document.body.style.cursor = ""
    notifyParent("inspector-mode", { enabled: false })
  }

  function onInspectorMove(e: MouseEvent) {
    const target = document.elementFromPoint(e.clientX, e.clientY)
    if (
      target &&
      !target.hasAttribute("data-proxy-highlight") &&
      target !== document.documentElement &&
      target !== document.body
    ) {
      highlightElement(target, { scroll: false })
    }
  }

  function onInspectorClick(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()

    const target = document.elementFromPoint(e.clientX, e.clientY)
    if (target && !target.hasAttribute("data-proxy-highlight")) {
      highlightElement(target, { scroll: false })
      disableInspector()
    }
  }

  // ─── CSS selector generation ────────────────────────────────────────────

  function getUniqueSelector(el: Element): string {
    if (el.id) return `#${CSS.escape(el.id)}`

    const path: string[] = []
    let current: Element | null = el

    while (current && current !== document.documentElement) {
      let selector = current.tagName.toLowerCase()

      if (current.id) {
        selector = `#${CSS.escape(current.id)}`
        path.unshift(selector)
        break
      }

      const parent = current.parentElement
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === current!.tagName,
        )
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1
          selector += `:nth-of-type(${index})`
        }
      }

      path.unshift(selector)
      current = parent
    }

    return path.join(" > ")
  }

  // ─── Utility ────────────────────────────────────────────────────────────

  function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }

  function notifyParent(type: string, data: any) {
    try {
      window.parent.postMessage({ source: "proxy-highlight", type, data }, "*")
    } catch {}
  }

  // ─── Listen for commands from parent ────────────────────────────────────

  window.addEventListener("message", (event) => {
    const msg = event.data
    if (!msg || msg.source !== "proxy-highlight-host") return

    switch (msg.type) {
      case "highlight-selector": {
        const el = document.querySelector(msg.selector)
        if (el) {
          highlightElement(el, {
            scroll: msg.scroll !== false,
            color: msg.color,
          })
        } else {
          notifyParent("error", {
            message: `Element not found: ${msg.selector}`,
          })
        }
        break
      }

      case "highlight-xpath": {
        const result = document.evaluate(
          msg.xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        )
        const el = result.singleNodeValue as Element | null
        if (el) {
          highlightElement(el, {
            scroll: msg.scroll !== false,
            color: msg.color,
          })
        } else {
          notifyParent("error", {
            message: `Element not found: ${msg.xpath}`,
          })
        }
        break
      }

      case "highlight-text": {
        // Find element containing specific text
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          null,
        )
        let found = false
        while (walker.nextNode()) {
          const node = walker.currentNode
          if (
            node.textContent &&
            node.textContent.includes(msg.text) &&
            node.parentElement
          ) {
            highlightElement(node.parentElement, {
              scroll: msg.scroll !== false,
              color: msg.color,
            })
            found = true
            break
          }
        }
        if (!found) {
          notifyParent("error", {
            message: `No element containing text: ${msg.text}`,
          })
        }
        break
      }

      case "enable-inspector":
        enableInspector()
        break

      case "disable-inspector":
        disableInspector()
        break

      case "clear-highlight":
        highlightElement(null)
        disableInspector()
        break

      case "update-config":
        config = { ...config, ...msg.config }
        if (currentTarget) {
          highlightElement(currentTarget, { scroll: false })
        }
        break

      case "get-dom-tree": {
        // Return a simplified DOM tree for the parent
        const tree = buildDomTree(document.body, msg.maxDepth || 4)
        notifyParent("dom-tree", { tree })
        break
      }

      case "get-element-info": {
        const el = document.querySelector(msg.selector)
        if (el) {
          const rect = el.getBoundingClientRect()
          const computed = window.getComputedStyle(el)
          notifyParent("element-info", {
            selector: msg.selector,
            tagName: el.tagName.toLowerCase(),
            id: el.id,
            classes: Array.from(el.classList),
            attributes: Array.from(el.attributes).map((a) => ({
              name: a.name,
              value: a.value,
            })),
            rect: {
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
            },
            computedStyle: {
              display: computed.display,
              position: computed.position,
              fontSize: computed.fontSize,
              color: computed.color,
              backgroundColor: computed.backgroundColor,
            },
            text: (el.textContent || "").trim().substring(0, 500),
            html: el.outerHTML.substring(0, 1000),
            childCount: el.children.length,
          })
        }
        break
      }
    }
  })

  // ─── DOM tree builder ───────────────────────────────────────────────────

  interface DomNode {
    tag: string
    id?: string
    classes?: string[]
    selector: string
    children?: DomNode[]
    text?: string
  }

  function buildDomTree(
    el: Element,
    maxDepth: number,
    depth = 0,
  ): DomNode | null {
    if (depth > maxDepth) return null
    if (el.hasAttribute("data-proxy-highlight")) return null
    if (el.hasAttribute("data-proxy-injected")) return null

    const node: DomNode = {
      tag: el.tagName.toLowerCase(),
      selector: getUniqueSelector(el),
    }

    if (el.id) node.id = el.id
    if (el.classList.length > 0) node.classes = Array.from(el.classList)

    const textNode = Array.from(el.childNodes).find(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
    )
    if (textNode) {
      node.text = (textNode.textContent || "").trim().substring(0, 100)
    }

    if (el.children.length > 0 && depth < maxDepth) {
      node.children = Array.from(el.children)
        .map((child) => buildDomTree(child, maxDepth, depth + 1))
        .filter(Boolean) as DomNode[]
    }

    return node
  }

  // ─── Keyboard shortcut ──────────────────────────────────────────────────

  document.addEventListener("keydown", (e) => {
    // Escape to clear highlight / exit inspector
    if (e.key === "Escape") {
      if (inspectorMode) {
        disableInspector()
      }
      highlightElement(null)
    }
    // Ctrl/Cmd + Shift + C to toggle inspector
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "C") {
      e.preventDefault()
      if (inspectorMode) {
        disableInspector()
      } else {
        enableInspector()
      }
    }
  })

  // ─── Intercept link navigation ──────────────────────────────────────────
  // Catch clicks on <a> links that would navigate to a different page
  // and notify the parent instead of allowing navigation.

  document.addEventListener(
    "click",
    (e: MouseEvent) => {
      // Don't interfere with inspector mode clicks
      if (inspectorMode) return

      // Walk up from target to find closest <a>
      let target = e.target as HTMLElement | null
      while (target && target.tagName !== "A") {
        target = target.parentElement
      }
      if (!target) return

      const anchor = target as HTMLAnchorElement
      const href = anchor.getAttribute("href")
      if (!href) return

      // Ignore same-page anchors, javascript:, mailto:, tel:
      if (
        href.startsWith("#") ||
        href.startsWith("javascript:") ||
        href.startsWith("mailto:") ||
        href.startsWith("tel:")
      )
        return

      // Determine the full URL this link would navigate to
      let fullUrl: string
      try {
        const resolved = new URL(href, window.location.href)
        // If it's same page with just a hash change, allow it
        if (
          resolved.pathname === window.location.pathname &&
          resolved.search === window.location.search &&
          resolved.hash !== window.location.hash
        )
          return

        // Reconstruct the original target URL
        const origin = (window as any).__PROXY_ORIGIN__ || ""
        fullUrl = origin
          ? origin + resolved.pathname + resolved.search + resolved.hash
          : resolved.href
      } catch {
        fullUrl = href
      }

      // Block the navigation
      e.preventDefault()
      e.stopPropagation()

      // Notify the parent window
      notifyParent("link-navigation", {
        url: fullUrl,
        text: (anchor.textContent || "").trim().substring(0, 200),
        selector: getUniqueSelector(anchor),
      })
    },
    true,
  )

  // Also intercept programmatic navigation via pushState/replaceState
  const origPushState = history.pushState
  const origReplaceState = history.replaceState

  history.pushState = function (state, title, url) {
    if (url) {
      const origin = (window as any).__PROXY_ORIGIN__ || ""
      let fullUrl: string
      try {
        const resolved = new URL(String(url), window.location.href)
        fullUrl = origin
          ? origin + resolved.pathname + resolved.search + resolved.hash
          : resolved.href
      } catch {
        fullUrl = String(url)
      }
      notifyParent("link-navigation", {
        url: fullUrl,
        text: "",
        selector: "",
        type: "pushState",
      })
    }
    // Block the actual navigation
    return
  }

  history.replaceState = function (state, title, url) {
    if (url && String(url) !== window.location.href) {
      const origin = (window as any).__PROXY_ORIGIN__ || ""
      let fullUrl: string
      try {
        const resolved = new URL(String(url), window.location.href)
        fullUrl = origin
          ? origin + resolved.pathname + resolved.search + resolved.hash
          : resolved.href
      } catch {
        fullUrl = String(url)
      }
      notifyParent("link-navigation", {
        url: fullUrl,
        text: "",
        selector: "",
        type: "replaceState",
      })
    }
    return
  }

  // ─── Notify parent that we're ready ─────────────────────────────────────

  notifyParent("ready", { url: window.location.href })
})()
