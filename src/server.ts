import express from "express"
import fetch, { Response as FetchResponse } from "node-fetch"
import * as cheerio from "cheerio"
import path from "path"
import fs from "fs"

const app = express()
const PORT = 3001

// ─── Track the target origin for catch-all routing ──────────────────────────
// When the user loads a page via /proxy?url=, we store its origin.
// All subsequent relative requests (/_next/*, /images/*, etc.) from the iframe
// are automatically proxied to this origin by the catch-all route.
let currentTargetOrigin = ""

// ─── Helpers ────────────────────────────────────────────────────────────────

function isHtml(ct: string | null): boolean {
  return !!ct && ct.includes("text/html")
}
function isCss(ct: string | null): boolean {
  return !!ct && ct.includes("text/css")
}
function isJs(ct: string | null): boolean {
  return !!ct && (ct.includes("javascript") || ct.includes("ecmascript"))
}
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// ─── Origin stripping ──────────────────────────────────────────────────────
// Instead of wrapping URLs in /proxy?url=..., we strip the target origin to
// make them relative. The catch-all route then proxies them transparently.
// e.g., "https://target.com/_next/static/main.js" → "/_next/static/main.js"
// This is critical for React hydration — the DOM stays close to what React expects.

function stripOriginInText(text: string, origin: string): string {
  if (!origin) return text
  return text.replace(new RegExp(escapeRegExp(origin), "g"), "")
}

function stripOriginInCss(css: string, origin: string): string {
  return stripOriginInText(css, origin)
}

// ─── Fetch helper with standard browser headers ─────────────────────────────

function buildFetchHeaders(targetOrigin: string): Record<string, string> {
  return {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "identity",
    Referer: targetOrigin + "/",
    Origin: targetOrigin,
  }
}

// ─── Set permissive response headers ────────────────────────────────────────

function setPermissiveHeaders(res: express.Response) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  )
  res.setHeader("Access-Control-Allow-Headers", "*")
  res.removeHeader("X-Frame-Options")
  res.removeHeader("Content-Security-Policy")
  res.removeHeader("Content-Security-Policy-Report-Only")
  res.removeHeader("X-Content-Type-Options")
}

// ─── HTML rewriting (minimal — preserve DOM for hydration) ──────────────────

function rewriteHtml(html: string, baseUrl: string): string {
  const $ = cheerio.load(html)
  const origin = new URL(baseUrl).origin

  // Remove <base> tags so relative URLs resolve to our proxy server
  $("base").remove()

  // Remove security headers that block our injection
  $('meta[http-equiv="Content-Security-Policy"]').remove()
  $('meta[http-equiv="Content-Security-Policy-Report-Only"]').remove()
  $('meta[http-equiv="X-Frame-Options"]').remove()

  // Remove integrity/nonce — SRI checksums break after proxying
  $("[integrity]").removeAttr("integrity")
  $("[nonce]").removeAttr("nonce")
  // Also remove crossorigin on scripts since they now load from same origin
  $("script[crossorigin]").removeAttr("crossorigin")
  $("link[crossorigin]").removeAttr("crossorigin")

  // ── Strip origin from absolute URLs to make them relative ─────────────
  // This is the KEY difference from before:
  // BEFORE: href="https://target.com/about" → href="/proxy?url=https%3A%2F%2Ftarget.com%2Fabout"
  // NOW:    href="https://target.com/about" → href="/about"
  // The catch-all route handles /about → target.com/about

  const originEscaped = escapeRegExp(origin)

  // All elements with src/href/action/data/poster attributes
  const urlAttrs = ["src", "href", "action", "data", "poster"]
  urlAttrs.forEach((attr) => {
    $(`[${attr}]`).each((_, el) => {
      const val = $(el).attr(attr)
      if (val && val.startsWith(origin)) {
        $(el).attr(attr, val.slice(origin.length) || "/")
      }
    })
  })

  // srcset
  $("[srcset]").each((_, el) => {
    const srcset = $(el).attr("srcset")
    if (srcset && srcset.includes(origin)) {
      $(el).attr("srcset", stripOriginInText(srcset, origin))
    }
  })

  // Inline styles
  $("[style]").each((_, el) => {
    const style = $(el).attr("style")
    if (style && style.includes(origin)) {
      $(el).attr("style", stripOriginInText(style, origin))
    }
  })
  $("style").each((_, el) => {
    const css = $(el).html()
    if (css && css.includes(origin)) {
      $(el).html(stripOriginInText(css, origin))
    }
  })

  // Inline scripts: strip origin so URLs become relative
  $("script:not([src])").each((_, el) => {
    if ($(el).attr("data-proxy-injected")) return
    const content = $(el).html()
    if (!content || !content.includes(origin)) return
    $(el).html(stripOriginInText(content, origin))
  })

  // ── Inject runtime patches at VERY TOP of <head> ─────────────────────
  const runtimePatch = buildRuntimePatch(origin)
  if ($("head").length) {
    $("head").prepend(runtimePatch)
  } else if ($("html").length) {
    $("html").prepend("<head>" + runtimePatch + "</head>")
  }

  // ── Inject highlight script at end of body ────────────────────────────
  const injectScript = fs.readFileSync(
    path.join(__dirname, "..", "dist-inject", "inject.js"),
    "utf-8",
  )
  const tag = `<script data-proxy-injected="true">${injectScript}</script>`
  if ($("body").length) {
    $("body").append(tag)
  } else {
    $("head").append(tag)
  }

  return $.html()
}

// ─── Runtime patch (executes BEFORE all page scripts) ───────────────────────

function buildRuntimePatch(origin: string): string {
  return `
<script data-proxy-injected="true">
(function(){
  "use strict";
  var ORIGIN = ${JSON.stringify(origin)};
  window.__PROXY_ORIGIN__ = ORIGIN;

  // Strip absolute origin URLs to make them relative
  // /_next/static/... stays as-is, https://target.com/_next/static/... → /_next/static/...
  function strip(u) {
    if (!u || typeof u !== 'string') return u;
    if (u.startsWith(ORIGIN)) return u.slice(ORIGIN.length) || '/';
    return u;
  }

  // For third-party domains, proxy explicitly
  function proxyOrStrip(u) {
    if (!u || typeof u !== 'string') return u;
    if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('javascript:') || u.startsWith('#')) return u;
    if (u.startsWith(ORIGIN)) return u.slice(ORIGIN.length) || '/';
    // Third-party absolute URL → proxy explicitly
    if (/^https?:\\/\\//.test(u) && !u.startsWith(location.origin)) {
      return '/proxy?url=' + encodeURIComponent(u);
    }
    return u;
  }
  window.__proxyOrStrip__ = proxyOrStrip;

  /* ── Patch fetch ── */
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') {
      input = proxyOrStrip(input);
    } else if (input && typeof input === 'object' && input.url) {
      try { input = new Request(proxyOrStrip(input.url), input); } catch(e) {}
    }
    return _fetch.call(this, input, init);
  };

  /* ── Patch XMLHttpRequest ── */
  var _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string') arguments[1] = proxyOrStrip(url);
    return _xhrOpen.apply(this, arguments);
  };

  /* ── Patch document.createElement — intercept dynamic script/link/img ── */
  var _create = document.createElement;
  document.createElement = function(tag, opts) {
    var el = _create.call(document, tag, opts);
    var t = (typeof tag === 'string') ? tag.toLowerCase() : '';
    if (t === 'script' || t === 'img' || t === 'video' || t === 'audio' || t === 'source' || t === 'embed') {
      patchElSrc(el);
    }
    if (t === 'link') {
      patchElHref(el);
    }
    return el;
  };

  function patchElSrc(el) {
    var orig = HTMLElement.prototype.setAttribute;
    el.setAttribute = function(n, v) {
      if (n === 'src') v = strip(v);
      if (n === 'integrity') return;
      return orig.call(this, n, v);
    };
  }

  function patchElHref(el) {
    var orig = HTMLElement.prototype.setAttribute;
    el.setAttribute = function(n, v) {
      if (n === 'href') v = strip(v);
      if (n === 'integrity') return;
      return orig.call(this, n, v);
    };
  }

  /* ── Patch appendChild / insertBefore — catch dynamic DOM additions ── */
  var origAppend = Node.prototype.appendChild;
  Node.prototype.appendChild = function(child) {
    fixChild(child);
    return origAppend.call(this, child);
  };
  var origInsert = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function(child, ref) {
    fixChild(child);
    return origInsert.call(this, child, ref);
  };

  function fixChild(child) {
    if (!child || !child.tagName) return;
    try {
      // Strip origin from src
      var src = child.getAttribute && child.getAttribute('src');
      if (src && src.startsWith(ORIGIN)) {
        child.setAttribute('src', src.slice(ORIGIN.length) || '/');
      }
      // Strip origin from href
      var href = child.getAttribute && child.getAttribute('href');
      if (href && href.startsWith(ORIGIN)) {
        child.setAttribute('href', href.slice(ORIGIN.length) || '/');
      }
      // Remove integrity
      child.removeAttribute('integrity');
      child.removeAttribute('crossorigin');
    } catch(e) {}
  }

  /* ── Patch window.open ── */
  var _open = window.open;
  window.open = function(url, target, features) {
    return _open.call(this, strip(url), target, features);
  };

  /* ── Patch Image constructor ── */
  var _Image = window.Image;
  window.Image = function(w, h) {
    var img = new _Image(w, h);
    patchElSrc(img);
    return img;
  };
  window.Image.prototype = _Image.prototype;

  /* ── EventSource (Next.js HMR) ── */
  if (window.EventSource) {
    var _ES = window.EventSource;
    window.EventSource = function(url, cfg) { return new _ES(strip(url), cfg); };
    window.EventSource.prototype = _ES.prototype;
  }

  /* ── WebSocket (Next.js HMR) → redirect to real host ── */
  if (window.WebSocket) {
    var _WS = window.WebSocket;
    window.WebSocket = function(url, protocols) {
      try {
        var p = new URL(url);
        if (p.hostname === location.hostname && String(p.port) === String(location.port)) {
          var t = new URL(ORIGIN);
          p.hostname = t.hostname;
          p.port = t.port || (p.protocol === 'wss:' ? '443' : '80');
          url = p.href;
        }
      } catch(e) {}
      return new _WS(url, protocols);
    };
    window.WebSocket.prototype = _WS.prototype;
    window.WebSocket.CONNECTING = _WS.CONNECTING;
    window.WebSocket.OPEN = _WS.OPEN;
    window.WebSocket.CLOSING = _WS.CLOSING;
    window.WebSocket.CLOSED = _WS.CLOSED;
  }

  /* ── Patch location.assign / replace — notify parent ── */
  var _assign = location.assign ? location.assign.bind(location) : null;
  var _replace = location.replace ? location.replace.bind(location) : null;
  if (_assign) {
    location.assign = function(url) {
      var full = url;
      if (url && url.startsWith('/')) full = ORIGIN + url;
      window.parent.postMessage({ source: 'proxy-highlight', type: 'link-navigation', data: { url: full, text: '', selector: '', type: 'location.assign' } }, '*');
    };
  }
  if (_replace) {
    location.replace = function(url) {
      var full = url;
      if (url && url.startsWith('/')) full = ORIGIN + url;
      window.parent.postMessage({ source: 'proxy-highlight', type: 'link-navigation', data: { url: full, text: '', selector: '', type: 'location.replace' } }, '*');
    };
  }

  console.log('[Proxy Highlighter] Runtime patches applied for:', ORIGIN);
})();
</script>
`
}

// ─── Process fetched content based on type ──────────────────────────────────

async function processAndSend(
  response: FetchResponse,
  finalUrl: string,
  res: express.Response,
  isMainHtml = false,
) {
  const contentType = response.headers.get("content-type")

  setPermissiveHeaders(res)

  // Forward useful headers
  const cacheControl = response.headers.get("cache-control")
  if (cacheControl) res.setHeader("Cache-Control", cacheControl)
  const etag = response.headers.get("etag")
  if (etag) res.setHeader("ETag", etag)

  let origin: string
  try {
    origin = new URL(finalUrl).origin
  } catch {
    origin = currentTargetOrigin
  }

  if (isHtml(contentType)) {
    const html = await response.text()
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    return res.send(rewriteHtml(html, finalUrl))
  }

  if (isCss(contentType)) {
    const css = await response.text()
    res.setHeader("Content-Type", contentType || "text/css")
    return res.send(stripOriginInCss(css, origin))
  }

  if (isJs(contentType)) {
    const js = await response.text()
    if (contentType) res.setHeader("Content-Type", contentType)
    // Strip origin URLs in JS files so they become relative
    return res.send(stripOriginInText(js, origin))
  }

  // JSON (Next.js page data, API responses)
  if (contentType && contentType.includes("application/json")) {
    const json = await response.text()
    if (contentType) res.setHeader("Content-Type", contentType)
    return res.send(stripOriginInText(json, origin))
  }

  // Everything else: binary passthrough
  if (contentType) res.setHeader("Content-Type", contentType)
  const buffer = await response.buffer()
  return res.send(buffer)
}

// ─── /proxy endpoint — explicit URL proxying ────────────────────────────────

app.get("/proxy", async (req, res) => {
  const targetUrl = req.query.url as string
  if (!targetUrl) {
    return res.status(400).json({ error: "Missing ?url= parameter" })
  }

  try {
    const parsedUrl = new URL(targetUrl)
    const targetOrigin = parsedUrl.origin

    const response = await fetch(targetUrl, {
      headers: buildFetchHeaders(targetOrigin),
      redirect: "follow",
    })

    const finalUrl = response.url
    const finalOrigin = new URL(finalUrl).origin

    // Update catch-all target if this is an HTML page
    const contentType = response.headers.get("content-type")
    if (isHtml(contentType)) {
      currentTargetOrigin = finalOrigin
      console.log(`[proxy] Target origin set to: ${currentTargetOrigin}`)
    }

    return processAndSend(response, finalUrl, res, isHtml(contentType))
  } catch (err: any) {
    console.error(`[proxy] Error for ${targetUrl}:`, err.message)
    return res.status(502).json({
      error: "Failed to fetch target URL",
      details: err.message,
      url: targetUrl,
    })
  }
})

// ─── CORS preflight ─────────────────────────────────────────────────────────

app.options("*", (_req, res) => {
  setPermissiveHeaders(res)
  res.sendStatus(204)
})

// ─── Static files for our UI ────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, "..", "public")))

// ─── Catch-all route — proxy everything else to target origin ───────────────
// This is the critical piece. When the iframe's page requests /_next/static/...,
// /images/..., /api/..., etc., those relative URLs resolve to our server.
// This route catches them and forwards to the actual target.

app.use(async (req, res) => {
  if (!currentTargetOrigin) {
    return res.status(404).json({
      error: "No target origin set. Load a page via /proxy?url= first.",
    })
  }

  // Build the target URL: target origin + original path + query string
  const targetUrl = currentTargetOrigin + req.originalUrl

  try {
    const fetchOpts: any = {
      method: req.method,
      headers: {
        ...buildFetchHeaders(currentTargetOrigin),
        Accept: req.headers.accept || "*/*",
      },
      redirect: "follow",
    }

    // Forward request body for POST/PUT/PATCH
    if (req.method !== "GET" && req.method !== "HEAD") {
      // Collect body
      const chunks: Buffer[] = []
      await new Promise<void>((resolve, reject) => {
        req.on("data", (chunk: Buffer) => chunks.push(chunk))
        req.on("end", resolve)
        req.on("error", reject)
      })
      if (chunks.length > 0) {
        fetchOpts.body = Buffer.concat(chunks)
        if (req.headers["content-type"]) {
          fetchOpts.headers["Content-Type"] = req.headers["content-type"]
        }
      }
    }

    const response = await fetch(targetUrl, fetchOpts)
    const finalUrl = response.url

    return processAndSend(response, finalUrl, res)
  } catch (err: any) {
    console.error(`[catch-all] Error for ${targetUrl}:`, err.message)
    return res.status(502).json({
      error: "Failed to fetch from target",
      details: err.message,
      url: targetUrl,
    })
  }
})

// ─── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 Proxy Highlighter running at http://localhost:${PORT}`)
  console.log(`   Open http://localhost:${PORT} in your browser\n`)
})
