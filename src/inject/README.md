# Inject Script - iframe Communication Guide

The `inject.ts` script is injected into every proxied page and provides element highlighting, overlay management, and communication between the iframe and the parent window using `postMessage`.

## Overview

This script enables:

- **Element highlighting** with colored overlays and borders
- **Text search** to find and highlight elements by content
- **CSS selector highlighting** to highlight specific elements
- **XPath support** for complex element selection
- **Smooth scrolling** to highlighted elements
- **Link interception** to prevent navigation and notify the parent
- **Real-time tracking** of highlighted elements during scroll/resize

## Communication Protocol

All communication between the parent window and iframe uses `postMessage` with a `source` identifier to prevent conflicts.

### Message Format

```javascript
// From parent to iframe
{
  source: "proxy-highlight-host",
  type: "message-type",
  // additional properties...
}

// From iframe to parent
{
  source: "proxy-highlight",
  type: "message-type",
  data: { /* data */ }
}
```

## Parent → Iframe Messages

### Highlight by CSS Selector

```javascript
iframe.contentWindow.postMessage(
  {
    source: "proxy-highlight-host",
    type: "highlight-selector",
    selector: ".button.primary", // CSS selector
    color: "#FF4444", // Hex color (optional)
    scroll: true, // Scroll to element (optional, default: true)
  },
  "*",
)
```

**Response:** `element-highlighted` message with element info, or `error` message if not found.

### Highlight by XPath

```javascript
iframe.contentWindow.postMessage(
  {
    source: "proxy-highlight-host",
    type: "highlight-xpath",
    xpath: "//button[@id='submit']", // XPath expression
    color: "#FF4444", // Hex color (optional)
    scroll: true, // Scroll to element (optional)
  },
  "*",
)
```

**Response:** `element-highlighted` message with element info, or `error` message if not found.

### Highlight by Text Content

```javascript
iframe.contentWindow.postMessage(
  {
    source: "proxy-highlight-host",
    type: "highlight-text",
    text: "Click here", // Text to search for
    color: "#FF4444", // Hex color (optional)
    scroll: true, // Scroll to element (optional)
  },
  "*",
)
```

**Response:** `element-highlighted` message with element info, or `error` message if not found.

### Clear Highlighting

```javascript
iframe.contentWindow.postMessage(
  {
    source: "proxy-highlight-host",
    type: "clear-highlight",
  },
  "*",
)
```

Removes all overlays and resets the highlighted element.

### Update Configuration

```javascript
iframe.contentWindow.postMessage(
  {
    source: "proxy-highlight-host",
    type: "update-config",
    config: {
      borderColor: "#4f8cff",
      borderWidth: 2,
      overlayColor: "rgba(79, 140, 255, 0.12)",
      scrollBehavior: "smooth",
    },
  },
  "*",
)
```

### Get DOM Tree (Optional)

```javascript
iframe.contentWindow.postMessage(
  {
    source: "proxy-highlight-host",
    type: "get-dom-tree",
    maxDepth: 4, // Maximum tree depth (optional, default: 4)
  },
  "*",
)
```

**Response:** `dom-tree` message with simplified DOM structure.

### Get Element Info (Optional)

```javascript
iframe.contentWindow.postMessage(
  {
    source: "proxy-highlight-host",
    type: "get-element-info",
    selector: ".my-element", // CSS selector
  },
  "*",
)
```

**Response:** `element-info` message with detailed element information (computed styles, attributes, dimensions, etc.).

---

## Iframe → Parent Messages

### Ready

```javascript
{
  source: "proxy-highlight",
  type: "ready",
  data: {
    url: "https://example.com/"  // The page URL
  }
}
```

Sent when the script initializes and the page is ready.

### Element Highlighted

```javascript
{
  source: "proxy-highlight",
  type: "element-highlighted",
  data: {
    tagName: "button",
    id: "submit-btn",
    classes: ["btn", "primary"],
    rect: {
      top: 100,
      left: 50,
      width: 120,
      height: 40
    },
    text: "Click here"
  }
}
```

Sent when an element is highlighted, containing element metadata.

### Link Navigation Intercepted

```javascript
{
  source: "proxy-highlight",
  type: "link-navigation",
  data: {
    url: "https://example.com/page",
    text: "Go to Page",  // Link text
    type: "click"        // "click", "pushState", or "replaceState"
  }
}
```

Sent when a link is clicked or `history.pushState/replaceState` is called. The navigation is blocked.

### Error

```javascript
{
  source: "proxy-highlight",
  type: "error",
  data: {
    message: "Element not found: .invalid-selector"
  }
}
```

Sent when an operation fails (e.g., element not found).

---

## Keyboard Shortcuts

| Shortcut | Action                                      |
| -------- | ------------------------------------------- |
| `Escape` | Clear highlighting and exit any active mode |

---

## Highlighting System

### Visual Elements

The highlighting system creates multiple fixed-position overlay elements:

1. **Dimmed Overlays** (4 rectangles)
   - Cover areas above, below, left, and right of the target
   - Semi-transparent with the highlight color
   - z-index: 2147483640

2. **Borders** (4 thin lines)
   - Form a rectangle around the target element
   - Solid color, configurable width
   - z-index: 2147483641

3. **Label**
   - Shows element tag, ID, classes, and dimensions
   - Positioned above or below the element
   - z-index: 2147483642

### Default Colors

```javascript
borderColor: "#FF4444"
overlayColor: "rgba(255, 68, 68, 0.12)" // 12% opacity
labelBackground: "#FF4444"
labelColor: "#FFFFFF"
```

### Configuration Options

```javascript
interface HighlightConfig {
  borderColor: string              // Hex color for border
  borderWidth: number              // Border width in pixels
  overlayColor: string             // RGBA color for overlay
  scrollBehavior: ScrollBehavior   // "smooth" or "auto"
  scrollBlock: ScrollLogicalPosition // "start", "center", "end", "nearest"
  labelBackground: string          // Background color for label
  labelColor: string              // Text color for label
}
```

---

## Link Interception

The script intercepts two types of navigation:

### 1. Link Clicks

Catches all `<a>` tag clicks and blocks them if they would navigate to a different page.

### 2. History API

Intercepts `history.pushState()` and `history.replaceState()` to prevent programmatic navigation.

**Ignored Links:**

- Same-page anchors (e.g., `href="#section"`)
- JavaScript URLs (e.g., `href="javascript:..."`)
- Mailto links (e.g., `href="mailto:..."`)
- Tel links (e.g., `href="tel:..."`)

---

## Usage Example

### From Parent Window

```javascript
const iframe = document.querySelector("iframe")

// Highlight a button by selector
iframe.contentWindow.postMessage(
  {
    source: "proxy-highlight-host",
    type: "highlight-selector",
    selector: "button.submit",
    color: "#4f8cff",
  },
  "*",
)

// Listen for responses
window.addEventListener("message", (event) => {
  const msg = event.data
  if (msg.source !== "proxy-highlight") return

  if (msg.type === "element-highlighted") {
    console.log("Element highlighted:", msg.data.tagName, msg.data.classes)
  } else if (msg.type === "link-navigation") {
    console.log("Link clicked:", msg.data.url)
  }
})

// Clear highlight after 3 seconds
setTimeout(() => {
  iframe.contentWindow.postMessage(
    {
      source: "proxy-highlight-host",
      type: "clear-highlight",
    },
    "*",
  )
}, 3000)
```

---

## Technical Details

### Script Initialization

- Runs immediately upon page load
- Prevents double-initialization with a global flag: `__PROXY_HIGHLIGHT_INIT__`
- Sets up all overlay elements in `document.documentElement`

### Performance

- Uses `requestAnimationFrame` for smooth overlay tracking during scroll/resize
- Overlays use `pointer-events: none` to avoid interfering with page interaction
- Fixed positioning ensures overlays stay visible during scrolling

### Security Notes

- The script uses `postMessage` with `"*"` as the target origin (accepts from any origin)
- Adjust target origin for production: `iframe.contentWindow.postMessage(..., "https://trusted-domain.com")`
- All DOM queries respect `data-proxy-highlight` attributes to avoid interfering with overlay elements
