/**
 * Shared UI kit (React via the runtime require) + the one stylesheet.
 *
 * The visual language is Apple's grouped-settings idiom rendered in the HOST's
 * palette:
 *  - content lives in rounded groups whose separators are INSET to the text,
 *    not drawn edge to edge;
 *  - a group is introduced by a short label above it and explained by a
 *    footnote BELOW it — never by a sentence wedged beside the title;
 *  - a list row carries at most ONE trailing control (a switch or a ⋯ menu)
 *    plus an optional chevron. `row()` is the only way to build one, so a row
 *    cannot grow the seven buttons it used to;
 *  - colour is structural, not decorative: near-black brand, greys, and red
 *    for destructive actions. The brand fill comes from the host's own
 *    --dsw-alias-brand-primary rather than Apple blue, so the panel belongs
 *    inside DSH instead of contrasting with it. The ONE exception is the type
 *    tile of a built-in connection kind, which carries its product's colour —
 *    see MARKS below for why that is recognition rather than decoration.
 *
 * Everything lives in ONE file on purpose: the tests import this module as
 * source, and Node's type stripping does not rewrite a './x.js' specifier to
 * a sibling .ts file — so a relative runtime import here does not merely fail,
 * it aborts the whole test module and takes every test after it with it.
 */

export const css = `
.mmc-root{--mmc-fg:var(--dsw-alias-label-primary,#1d1d1f);--mmc-fg2:var(--dsw-alias-label-secondary,#6e6e73);--mmc-fg3:var(--dsw-alias-label-tertiary,#8e8e93);--mmc-line:var(--dsw-alias-border-l2,rgba(0,0,0,.1));--mmc-hair:var(--dsw-alias-border-l1,rgba(0,0,0,.07));--mmc-bg:var(--dsw-alias-bg-layer-1,#fff);--mmc-fill:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));--mmc-brand:var(--dsw-alias-brand-primary,#1d1d1f);--mmc-on-brand:var(--dsw-alias-label-primary-inverted,#fff);--mmc-danger:var(--dsw-alias-state-error-primary,#d70015);--mmc-ok:var(--dsw-alias-state-success-primary,#30a46c);--mmc-r:12px;--mmc-inset:34px;color:var(--mmc-fg);font-family:var(--ds-font-family,-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif);font-size:13px;line-height:1.45;letter-spacing:-.01em;display:flex;flex-direction:column;gap:18px;max-width:720px;min-width:0}
/* Session view owns neither the host scrollport nor the floating composer.
   As in dsh-request-log: the chat-width strips overlay/steal hits on plugin
   content which does not use --dsh-chat-content-width. Hide ONLY these strips
   while this view is mounted; outer pane splitters and Chat remain untouched. */
[data-conversation-scroll]:has(.mmc-session) ~ [data-width-handle]{display:none}
.mmc-root.mmc-session{box-sizing:border-box;width:100%;max-width:800px;margin-inline:auto;padding:20px 24px 32px;gap:16px;container-type:inline-size}
.mmc-session *,.mmc-session *::before,.mmc-session *::after{box-sizing:border-box;min-width:0}
.mmc-session-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.mmc-session-head h3{margin:0 0 4px;font-size:14px;font-weight:600}
.mmc-session-navigation{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.mmc-session-navigation .mmc-tabs{margin:0;flex-wrap:wrap}
.mmc-session-change{border:0;border-radius:6px;padding:4px 8px;background:var(--mmc-fill);color:var(--mmc-fg2);font:inherit;font-size:11px;cursor:pointer}
.mmc-session-services{border:1px solid var(--mmc-line);border-radius:var(--dsw-radius-md,12px);overflow:hidden;background:var(--mmc-bg)}
.mmc-session-service+.mmc-session-service,.mmc-session-config-row+.mmc-session-config-row{border-top:1px solid var(--mmc-hair)}
.mmc-session-summary{display:flex;align-items:center;gap:10px;min-height:52px;padding:12px 14px;cursor:pointer;list-style:none}
.mmc-session-summary::-webkit-details-marker{display:none}
.mmc-session-summary:hover{background:var(--mmc-fill)}
.mmc-session-summary:focus-visible,.mmc-session-copy:focus-visible,.mmc-session-change:focus-visible{outline:2px solid var(--mmc-brand);outline-offset:-2px}
.mmc-session-service-icon{flex:none;color:var(--mmc-fg2)}
.mmc-session-name{flex:1;overflow-wrap:anywhere;font-weight:500}
.mmc-session-transport{font-size:11px;color:var(--mmc-fg3);flex:none}
.mmc-session-tool-count{font-size:12px;color:var(--mmc-fg2);flex:none;white-space:nowrap}
.mmc-session-chevron{flex:none;color:var(--mmc-fg3);transition:transform .12s}
.mmc-session-service[open]>.mmc-session-summary .mmc-session-chevron{transform:rotate(90deg)}
.mmc-session-tools{border-top:1px solid var(--mmc-hair);padding:4px 14px 8px 44px}
.mmc-session-tool{display:flex;align-items:flex-start;gap:12px;padding:10px 0}
.mmc-session-tool+.mmc-session-tool{border-top:1px solid var(--mmc-hair)}
.mmc-session-tool-text{flex:1}
.mmc-session-tool code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:12px;overflow-wrap:anywhere}
.mmc-session-tool p{font-size:12px;color:var(--mmc-fg2);margin:5px 0 0;overflow-wrap:anywhere}
.mmc-session-copy{display:flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:var(--mmc-fg3);cursor:pointer}
.mmc-session-copy:hover{background:var(--mmc-fill);color:var(--mmc-fg)}
.mmc-session-registered,.mmc-session-configuration{display:flex;flex-direction:column;gap:12px}
.mmc-session-notice{padding:10px 12px;border-radius:8px;background:var(--mmc-fill);color:var(--mmc-fg2);font-size:12px;overflow-wrap:anywhere}
.mmc-session-notice.error{color:var(--mmc-danger)}
.mmc-session-config-row{display:flex;align-items:center;gap:12px;padding:12px 14px;flex-wrap:wrap}
.mmc-session-config-source{font-size:11px;color:var(--mmc-fg3)}
.mmc-session-info{font-size:11px;color:var(--mmc-fg3)}
.mmc-session-info>summary{cursor:pointer;list-style:none}
.mmc-session-info>div{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 12px;margin-top:10px}
.mmc-session-info code,.mmc-session-info time{font:inherit;overflow-wrap:anywhere}
@container(max-width:400px){.mmc-session-tools{padding-left:14px}.mmc-session-summary{gap:8px}.mmc-session-transport{display:none}.mmc-session-config-source{flex-basis:100%}}
.mmc-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-width:0}
.mmc-sub{color:var(--mmc-fg2);font-size:12px;min-width:0}
.mmc-head>.mmc-sub{flex:1 1 200px}
.mmc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}
.mmc-row>.mmc-input{flex:0 1 240px}
.mmc-target{display:flex;align-items:center;gap:10px;width:100%;min-height:46px;padding:10px 14px;border:0;background:transparent;color:var(--mmc-fg);font:inherit;text-align:left;cursor:pointer}
.mmc-target+.mmc-target{border-top:0.5px solid var(--mmc-line)}
.mmc-target:hover{background:var(--mmc-fill)}
.mmc-target:focus-visible{outline:2px solid var(--mmc-brand);outline-offset:-2px}
.mmc-target-label{min-width:0;overflow-wrap:anywhere}
.mmc-target>.mmc-chev{margin-left:auto}
.mmc-ws-picker{flex:0 1 260px;min-width:0;max-width:100%}
.mmc-ws-trigger{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l4,var(--mmc-line));border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,var(--mmc-bg));color:var(--dsw-alias-label-primary,var(--mmc-fg));font:inherit;text-align:left;cursor:pointer}
.mmc-ws-trigger:hover,.mmc-ws-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,var(--mmc-fill))}
.mmc-ws-trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--mmc-brand));outline-offset:2px}
.mmc-ws-trigger>svg{flex:none;color:var(--dsw-alias-label-tertiary,var(--mmc-fg3))}
.mmc-ws-trigger-label{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
/* Portaled above the settings modal: use host tokens, not .mmc-root inheritance. */
.mmc-ws-popup{position:fixed;z-index:1100;display:flex;flex-direction:column;gap:4px;box-sizing:border-box;padding:4px;border:0;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary,#1d1d1f);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1,rgba(0,0,0,.08));box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.14));font-family:var(--ds-font-family,system-ui,sans-serif);font-size:13px;line-height:20px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2,rgba(0,0,0,.2));--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2,rgba(0,0,0,.35))}
.mmc-ws-popup[data-host-surface=true]{background:none}
.mmc-ws-search{display:flex;align-items:center;flex:none;gap:6px;height:32px;margin:4px;padding:0 8px;box-sizing:border-box;min-width:0;border:0.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.12));border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-tertiary,#8e8e93)}
.mmc-ws-search:focus-within{border-color:var(--dsw-alias-state-business-primary,#1d1d1f)}
.mmc-ws-search-input{width:100%;min-width:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary,#1d1d1f);font:inherit}
.mmc-ws-search-input::placeholder{color:var(--dsw-alias-label-dimmed,#8e8e93)}
.mmc-ws-options{overflow-y:auto;overscroll-behavior:contain;min-height:0;padding:0;scroll-padding:4px}
.mmc-ws-option{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;min-height:34px;padding:6px 8px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.mmc-ws-option:hover,.mmc-ws-option[data-active=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.mmc-ws-option>svg{flex:none;color:var(--dsw-alias-label-tertiary,#8e8e93)}
.mmc-ws-option-text{display:flex;flex-direction:column;flex:1;min-width:0}
.mmc-ws-option-label,.mmc-ws-option-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mmc-ws-option-path{color:var(--dsw-alias-label-secondary,#6e6e73);font-size:11px;line-height:17px}
.mmc-ws-check{display:flex;align-items:center;flex:none;width:16px;color:var(--dsw-alias-label-primary,#1d1d1f)}
.mmc-ws-empty{padding:12px 8px;color:var(--dsw-alias-label-secondary,#6e6e73)}
.mmc-spacer{flex:1 1 auto}
.mmc-strip{flex:1 1 260px;gap:6px}
.mmc-section{display:flex;flex-direction:column;gap:8px;min-width:0}
.mmc-shead{display:flex;align-items:center;gap:12px;min-width:0;flex-wrap:wrap}
.mmc-label{font-size:13px;font-weight:600;color:var(--mmc-fg);letter-spacing:-.01em;flex:1 1 auto;min-width:0}
.mmc-foot{font-size:11px;color:var(--mmc-fg3);padding:0 2px;overflow-wrap:anywhere}
.mmc-card{border:1px solid var(--mmc-line);border-radius:var(--mmc-r);padding:12px 14px;display:flex;flex-direction:column;gap:10px;background:var(--mmc-bg);min-width:0}
.mmc-rows{display:flex;flex-direction:column;min-width:0;border:1px solid var(--mmc-line);border-radius:var(--mmc-r);background:var(--mmc-bg);overflow:hidden}
.mmc-r{position:relative;display:flex;gap:10px;row-gap:4px;align-items:center;flex-wrap:wrap;padding:8px 12px;min-height:40px;min-width:0;box-sizing:border-box}
.mmc-rows>.mmc-r+.mmc-r::before{content:"";position:absolute;left:var(--mmc-inset);right:0;top:0;height:1px;background:var(--mmc-hair)}
.mmc-r[data-open]{background:var(--mmc-fill)}
.mmc-r[data-tap]:hover{background:var(--mmc-fill)}
.mmc-r[data-off] .mmc-name{color:var(--mmc-fg3)}
.mmc-name{font-weight:400;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mmc-open{display:flex;gap:6px;align-items:center;min-width:0;flex:0 1 auto;background:none;border:none;padding:0;margin:0;font:inherit;color:inherit;letter-spacing:inherit;text-align:left;cursor:pointer}
.mmc-meta{color:var(--mmc-fg3);font-size:12px;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mmc-trailmenu{display:contents}
.mmc-trail{display:flex;gap:6px;align-items:center;margin-left:auto;flex:none;padding-left:6px}
.mmc-chev{color:var(--mmc-fg3);font-size:15px;line-height:1;flex:none;transition:transform .15s ease}
.mmc-chev[data-open]{transform:rotate(90deg)}
.mmc-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end;margin-left:auto;flex:none}
.mmc-sw{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:36px;height:22px;padding:0;margin:0;border:none;border-radius:11px;background:var(--mmc-line);cursor:pointer;transition:background .18s ease}
.mmc-sw::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.28);transition:transform .18s ease}
.mmc-sw[aria-checked=true]{background:var(--mmc-brand)}
.mmc-sw[aria-checked=true]::after{transform:translateX(14px)}
.mmc-sw:disabled{opacity:.4;cursor:default}
.mmc-more{flex:none;width:26px;height:26px;display:flex;align-items:center;justify-content:center;padding:0;border:none;border-radius:7px;background:none;color:var(--mmc-fg2);font-size:15px;line-height:1;cursor:pointer}
.mmc-more:hover,.mmc-more[aria-expanded=true]{background:var(--mmc-fill);color:var(--mmc-fg)}
.mmc-menu{position:fixed;z-index:60;min-width:158px;max-width:280px;padding:5px;display:flex;flex-direction:column;gap:1px;background:var(--mmc-bg);border:1px solid var(--mmc-line);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.16)}
.mmc-mi{display:block;width:100%;text-align:left;padding:6px 10px;border:none;border-radius:6px;background:none;font:inherit;font-size:13px;letter-spacing:-.01em;color:var(--mmc-fg);cursor:pointer;white-space:nowrap}
.mmc-mi:hover:not(:disabled){background:var(--mmc-fill)}
.mmc-mi:disabled{opacity:.4;cursor:default}
.mmc-mi[data-danger]{color:var(--mmc-danger)}
.mmc-tag{font-size:11px;line-height:17px;color:var(--mmc-fg2);background:var(--mmc-fill);border-radius:5px;padding:0 6px;white-space:nowrap;flex:none;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.mmc-tag[data-tone=off]{color:var(--mmc-fg3)}
.mmc-tag[data-tone=warn]{color:var(--mmc-danger);background:none;box-shadow:inset 0 0 0 1px var(--mmc-danger)}
.mmc-icon{flex:none;width:22px;height:22px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;overflow:hidden}
.mmc-iconart{display:block}
.mmc-icontext{color:#fff;font-size:9px;font-weight:600;letter-spacing:0;text-transform:uppercase;line-height:1}
.mmc-r[data-off] .mmc-icon{filter:grayscale(1);opacity:.45}
.mmc-dot{width:7px;height:7px;border-radius:50%;background:var(--mmc-danger);flex:none}
.mmc-dot[data-ok]{background:var(--mmc-ok)}
.mmc-dot[data-off]{background:var(--mmc-fg3);opacity:.45}
.mmc-btn{background:var(--mmc-bg);color:var(--mmc-fg);border:1px solid var(--mmc-line);border-radius:7px;padding:4px 12px;font-size:12px;font-weight:500;line-height:18px;letter-spacing:-.01em;cursor:pointer;white-space:nowrap;flex:none;box-shadow:0 1px 1px rgba(0,0,0,.03)}
.mmc-btn:hover:not(:disabled){background:var(--mmc-fill)}
.mmc-btn:disabled{opacity:.4;cursor:default;box-shadow:none}
.mmc-btn[data-primary]{background:var(--mmc-brand);color:var(--mmc-on-brand);border-color:var(--mmc-brand)}
.mmc-btn[data-primary]:hover:not(:disabled){opacity:.85;background:var(--mmc-brand)}
.mmc-btn[data-primary]:disabled{background:var(--mmc-bg);color:var(--mmc-fg);border-color:var(--mmc-line)}
.mmc-btn[data-danger]{color:var(--mmc-danger)}
.mmc-btn[data-danger]:hover:not(:disabled){border-color:var(--mmc-danger)}
.mmc-btn[data-wide]{min-width:64px}
.mmc-btn[data-plain]{border:none;box-shadow:none;background:none;padding:4px 6px}
.mmc-btn[data-plain]:hover:not(:disabled){background:var(--mmc-fill)}
.mmc-input,textarea.mmc-input{background:var(--mmc-bg);border:1px solid var(--mmc-line);border-radius:7px;color:var(--mmc-fg);font-family:inherit;font-size:12px;letter-spacing:-.01em;padding:5px 9px;outline:none;min-width:0}
.mmc-input:focus{border-color:var(--mmc-brand);box-shadow:0 0 0 3px var(--mmc-fill)}
.mmc-input:read-only{color:var(--mmc-fg2);background:var(--mmc-fill)}
textarea.mmc-input{width:100%;min-height:110px;font-family:var(--ds-font-family-code,ui-monospace,monospace)}
.mmc-note{color:var(--mmc-fg2);font-size:12px;min-width:0;overflow-wrap:anywhere}
.mmc-error{color:var(--mmc-danger);font-size:12px;white-space:pre-wrap}
.mmc-empty{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:10px 0;color:var(--mmc-fg3);font-size:12px;min-width:0}
.mmc-ghead{padding:5px 12px;background:var(--mmc-fill);font-size:11px;font-weight:600;color:var(--mmc-fg3);letter-spacing:.02em}
.mmc-tabs{display:inline-flex;gap:2px;padding:2px;background:var(--mmc-fill);border-radius:9px;align-self:flex-start;max-width:100%;overflow:auto}
/* The page body is a COLUMN with a fixed height that scrolls. Its children
   must therefore keep their natural height: a flex item that sets an overflow
   has its automatic minimum size resolve to 0, so the default flex-shrink
   squeezed it to nothing as soon as a sibling was taller than the pane. That
   is what made the tab strip (overflow:auto, for narrow panes) collapse from
   28px to 4px on the tallest tab - the strip disappeared, and with it the way
   back to any other tab. */
.mmc-root>*{flex:0 0 auto}
.mmc-tab{border:none;background:none;color:var(--mmc-fg2);padding:4px 12px;border-radius:7px;font-size:12px;font-weight:500;letter-spacing:-.01em;cursor:pointer;white-space:nowrap}
.mmc-tab:hover{color:var(--mmc-fg)}
.mmc-tab[data-active]{background:var(--mmc-bg);color:var(--mmc-fg);box-shadow:0 1px 2px rgba(0,0,0,.12)}
.mmc-back{display:flex;align-items:center;gap:8px;min-width:0}
.mmc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:2px 14px}
.mmc-kv{display:grid;grid-template-columns:max-content minmax(0,max-content);gap:2px 8px;align-items:baseline;font-size:12px;min-width:0}
.mmc-kv>span:first-child{color:var(--mmc-fg3)}
.mmc-kv>span:last-child{overflow-wrap:anywhere}
.mmc-grid>.mmc-kv{grid-template-columns:minmax(64px,max-content) minmax(0,1fr);padding:5px 0;box-shadow:inset 0 -1px 0 var(--mmc-hair)}
.mmc-monospace{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;letter-spacing:0;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto;background:var(--mmc-fill);border-radius:8px;padding:10px}
.mmc-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px 14px;min-width:0}
.mmc-field{display:flex;flex-direction:column;gap:4px;min-width:0;grid-column:1/-1}
.mmc-field[data-half]{grid-column:auto}
.mmc-field>label{font-size:11px;color:var(--mmc-fg3)}
.mmc-field .mmc-input{width:100%}
.mmc-field textarea.mmc-input{min-height:60px}
.mmc-hint{color:var(--mmc-fg3);font-size:11px;overflow-wrap:anywhere}
.mmc-hint[data-clamp]{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden}
.mmc-check{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--mmc-fg);cursor:pointer}

/* Scoped editor geometry: 100% includes padding/border, never spills past the card. */
.mmc-editor,.mmc-editor *{box-sizing:border-box}
.mmc-editor{container-type:inline-size;min-width:0;width:100%;border:0.5px solid var(--mmc-line);border-radius:var(--dsw-radius-lg,16px);background:var(--mmc-bg);overflow:hidden}
.mmc-editor-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 22px;border-bottom:0.5px solid var(--mmc-hair)}
.mmc-editor-heading{min-width:0;flex:1}
.mmc-editor-heading h3{margin:0;font-size:15px;font-weight:600;line-height:22px;color:var(--mmc-fg)}
.mmc-editor-source{margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mmc-fg3);font-size:11px;line-height:17px}
.mmc-editor-header .mmc-tabs{flex:none;align-self:center;padding:2px;border-radius:var(--dsw-radius-sm,8px)}
.mmc-editor-header .mmc-tab{height:28px;padding:3px 12px;font-size:12px;line-height:20px}
.mmc-editor-body{display:flex;flex-direction:column;gap:18px;padding:20px 22px;min-width:0}
.mmc-editor-basics{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;min-width:0}
.mmc-editor-basics .mmc-field{grid-column:auto}
.mmc-editor .mmc-fields{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;min-width:0}
.mmc-editor .mmc-field{gap:7px;min-width:0}
.mmc-editor .mmc-field>label{font-size:12px;line-height:18px;font-weight:500;color:var(--mmc-fg2)}
.mmc-editor-name-label{display:flex;flex-direction:column;gap:7px}
.mmc-editor .mmc-input{display:block;width:100%;max-width:100%;min-width:0;min-height:36px;margin:0;padding:7px 10px;border:0.5px solid var(--dsw-alias-border-l4,var(--mmc-line));border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,var(--mmc-bg));color:var(--mmc-fg);font-family:inherit;font-size:13px;line-height:20px;box-shadow:none}
.mmc-editor .mmc-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,var(--mmc-brand));box-shadow:none}
.mmc-editor .mmc-input::placeholder{color:var(--dsw-alias-label-dimmed,var(--mmc-fg3));opacity:1}
.mmc-editor .mmc-field textarea.mmc-input{min-height:84px;resize:vertical}
.mmc-editor .mmc-editor-code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:20px}
.mmc-editor-select{position:relative;min-width:0}
.mmc-editor-select .mmc-input{appearance:none;padding-right:34px;cursor:pointer;text-overflow:ellipsis}
.mmc-editor-select>svg{position:absolute;right:10px;top:10px;pointer-events:none;color:var(--mmc-fg3)}
.mmc-editor .mmc-hint{font-size:11px;line-height:17px}
.mmc-editor-advanced{min-width:0;border-top:0.5px solid var(--mmc-hair);padding-top:14px}
.mmc-editor-advanced>summary{display:flex;align-items:center;gap:8px;min-height:26px;list-style:none;cursor:pointer;color:var(--mmc-fg2);font-size:12px;font-weight:500;user-select:none}
.mmc-editor-advanced>summary::-webkit-details-marker{display:none}
.mmc-editor-advanced>summary::marker{content:''}
.mmc-editor-advanced>summary:focus-visible{outline:2px solid var(--mmc-brand);outline-offset:3px;border-radius:4px}
.mmc-editor-optional{margin-left:auto;color:var(--mmc-fg3);font-size:11px;font-weight:400}
.mmc-editor-disclosure{display:flex;align-items:center;color:var(--mmc-fg3)}
.mmc-editor-advanced[open] .mmc-editor-disclosure{transform:rotate(180deg)}
.mmc-editor-advanced>.mmc-fields{padding-top:16px}
.mmc-editor-json{display:flex;flex-direction:column;gap:10px;min-width:0}
.mmc-editor-json>.mmc-input{min-height:240px;max-height:440px;resize:vertical}
.mmc-editor-imported,.mmc-editor-feedback{padding:9px 11px;border-radius:8px;background:var(--mmc-fill);color:var(--mmc-fg2);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.mmc-editor-conflict{display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.mmc-editor-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 22px;border-top:0.5px solid var(--mmc-hair);background:var(--mmc-bg)}
.mmc-editor-footer .mmc-actions{gap:8px}
.mmc-editor-footer .mmc-btn{min-height:32px;padding:5px 14px;font-size:13px;line-height:20px;border-radius:var(--dsw-radius-sm,8px)}
.mmc-editor-footer>.mmc-btn{padding-left:0;color:var(--mmc-fg2);background:transparent;border-color:transparent}
.mmc-editor-footer .mmc-btn[data-primary]:disabled{opacity:1;background:var(--mmc-fill);border-color:transparent;color:var(--mmc-fg3)}
@container(min-width:460px){.mmc-editor-basics{grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr)}.mmc-editor-basics[data-json=true]{grid-template-columns:minmax(0,1fr)}}
@container(max-width:420px){.mmc-editor-header{padding:16px;gap:12px;flex-wrap:wrap}.mmc-editor-body{padding:16px;gap:16px}.mmc-editor-footer{padding:12px 16px}.mmc-editor .mmc-fields{grid-template-columns:minmax(0,1fr)}}
`

/**
 * Type marks for the built-in connection kinds.
 *
 * A row that says "mysql" in a grey chip makes the eye READ before it can
 * recognise; a tinted tile is recognised before it is read, which is the whole
 * point of an icon. So each kind gets its product's own colour and a shape
 * that evokes its logo — Redis's stacked layers, MongoDB's leaf, a database
 * cylinder for the two SQL engines (distinguished by MySQL teal vs Postgres
 * blue), a globe for the HTTP kinds, a prompt for the process kinds.
 *
 * These are original simplified glyphs drawn from primitives, not copies of
 * the vendors' logo artwork — the colour carries the recognition, and no
 * trademarked mark is redistributed.
 *
 * `tint` is the ONLY place colour is allowed to be decorative in this panel:
 * everywhere else the palette is the host's monochrome brand plus red for
 * destructive actions.
 */
interface Mark {
  tint: string
  /** Shapes drawn white on the tile, in a 16x16 viewBox. */
  shapes: Array<[string, Record<string, unknown>]>
  /** Fallback when a shape cannot say it: one or two characters. */
  text?: string
}

const CYLINDER: Array<[string, Record<string, unknown>]> = [
  ['ellipse', { cx: 8, cy: 4.3, rx: 4.9, ry: 2.1 }],
  ['path', { d: 'M3.1 4.3v7.4c0 1.2 2.2 2.1 4.9 2.1s4.9-.9 4.9-2.1V4.3' }],
  ['path', { d: 'M3.1 8c0 1.2 2.2 2.1 4.9 2.1s4.9-.9 4.9-2.1' }],
]

const MARKS: Record<string, Mark> = {
  // Two SQL engines share the cylinder and are told apart by brand colour.
  mysql: { tint: '#00758f', shapes: CYLINDER, text: 'My' },
  pg: { tint: '#336791', shapes: CYLINDER, text: 'Pg' },
  // Redis's mark is a stack of layers.
  redis: {
    tint: '#d82c20',
    text: 'Rs',
    shapes: [
      ['ellipse', { cx: 8, cy: 4.4, rx: 4.9, ry: 1.9 }],
      ['ellipse', { cx: 8, cy: 8, rx: 4.9, ry: 1.9 }],
      ['ellipse', { cx: 8, cy: 11.6, rx: 4.9, ry: 1.9 }],
    ],
  },
  // MongoDB's mark is a leaf.
  mongo: {
    tint: '#13aa52',
    text: 'Mg',
    shapes: [
      ['path', { d: 'M8 1.6c2.6 3 3.8 5.2 3.8 7.3 0 2.4-1.5 4.2-3.8 5.5-2.3-1.3-3.8-3.1-3.8-5.5 0-2.1 1.2-4.3 3.8-7.3z' }],
      ['path', { d: 'M8 4.2v9.2' }],
    ],
  },
  http: {
    tint: '#5b6470',
    text: 'Ht',
    shapes: [
      ['circle', { cx: 8, cy: 8, r: 5.5 }],
      ['path', { d: 'M2.5 8h11' }],
      ['path', { d: 'M8 2.5c1.6 1.7 2.4 3.6 2.4 5.5S9.6 11.8 8 13.5C6.4 11.8 5.6 9.9 5.6 8S6.4 4.2 8 2.5z' }],
    ],
  },
  proc: {
    tint: '#5a5f66',
    text: 'Pr',
    shapes: [
      ['path', { d: 'M3.6 4.8L7 8l-3.4 3.2' }],
      ['path', { d: 'M8.4 11.4h4' }],
    ],
  },
  remote: {
    tint: '#4a6fa5',
    text: 'Rm',
    shapes: [
      ['path', { d: 'M4.7 12.1h6.6a2.7 2.7 0 0 0 .3-5.4 3.9 3.9 0 0 0-7.1-.5 2.5 2.5 0 0 0 .2 5.9z' }],
    ],
  },
  echo: {
    tint: '#8e8e93',
    text: 'Ec',
    shapes: [
      ['circle', { cx: 8, cy: 8, r: 1.5, fill: '#fff', stroke: 'none' }],
      ['path', { d: 'M11.1 4.9a4.4 4.4 0 0 1 0 6.2' }],
      ['path', { d: 'M4.9 11.1a4.4 4.4 0 0 1 0-6.2' }],
    ],
  },
}

// rest is an HTTP kind; stdio is a process kind. Same mark, same meaning.
MARKS.rest = { ...MARKS.http!, text: 'Re' }
MARKS.stdio = { ...MARKS.proc!, text: 'St' }

/** Every kind that has a mark of its own — the rest fall back to initials. */
function hasMark(type: string): boolean {
  return Object.hasOwn(MARKS, type)
}

/** The tile colour for a kind, for callers that tint something else by it. */
function tintOf(type: string): string {
  return MARKS[type]?.tint ?? '#8e8e93'
}

/**
 * The 18px tile for one kind. An unknown kind still gets a tile — its first
 * two characters on a neutral ground — so a list never mixes rows that have
 * a leading icon with rows that do not.
 */
function iconOf(React: ReactLike, type: string, title?: string): unknown {
  const h = React.createElement
  const mark = MARKS[type]
  const label = title ?? type
  const inner = mark === undefined
    ? h('span', { className: 'mmc-icontext' }, (type === '' ? '?' : type).slice(0, 2))
    : h('svg', {
        className: 'mmc-iconart', viewBox: '0 0 16 16', width: 18, height: 18,
        fill: 'none', stroke: '#fff', strokeWidth: 1.35, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false',
      }, mark.shapes.map(([tag, props], i) => h(tag, { key: String(i), ...props })))
  return h('span', {
    className: 'mmc-icon', title: label, role: 'img', 'aria-label': label,
    style: { background: mark?.tint ?? '#8e8e93' },
  }, inner)
}

/** The React bindings the loader hands the factory. */
export interface ReactLike {
  createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown
  /**
   * Both of React's forms. The LAZY one (a function that returns the initial
   * value) is the only way to keep a mutable box - a debounce timer, an
   * in-flight request id - that survives renders without being one: passing
   * the box directly would build a fresh one on every render.
   */
  useState: {
    <T>(initial: () => T): [T, (next: T | ((cur: T) => T)) => void]
    <T>(initial: T): [T, (next: T | ((cur: T) => T)) => void]
  }
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => void
  useCallback: <T extends (...args: never[]) => unknown>(fn: T, deps: unknown[]) => T
  useSyncExternalStore: unknown
}

/**
 * Chip tone. The DEFAULT is neutral; 'warn' paints the error colour and is
 * reserved for something actually wrong. Ordinary facts take 'info'/'off',
 * because an all-red list trains the eye to ignore red.
 */
export type Tone = 'warn' | 'info' | 'off'

/** One entry of a row's ⋯ menu. */
export interface MenuItem {
  label: string
  onPick: () => void
  danger?: boolean
  disabled?: boolean
}

/**
 * A list row. Everything a row may contain is named here, which is the point:
 * the trailing area holds at most ONE control — a switch OR a ⋯ menu — plus
 * the drill-in chevron. Rows used to be assembled by hand and grew to seven
 * buttons apiece.
 */
export interface RowSpec {
  key?: string
  /**
   * Leading type tile (mysql / pg / redis / mongo / http / proc …). When a
   * row has one it takes the leading slot from the status dot, the way an
   * app icon leads a settings row — except for an ERROR, which keeps its dot
   * because a fault is worth the pixels.
   */
  icon?: string
  /** Leading status dot. Omit for rows that have no state to report. */
  state?: 'ok' | 'off' | 'bad'
  name: string
  /** The grey fact line: everything that is not identity, already joined. */
  meta?: string
  /** At most one classifying chip. */
  badge?: { text: string; tone?: Tone }
  /** Drill in / expand. Renders the chevron and makes the name a button. */
  onOpen?: () => void
  open?: boolean
  toggle?: { on: boolean; onChange: (next: boolean) => void; label?: string; disabled?: boolean }
  /**
   * ONE trailing button, for a row whose content IS an action (Export,
   * Install, Measure). Mutually exclusive with `toggle` in practice — the
   * rule the row model enforces is at most one always-visible control, not
   * that the control must be a switch.
   */
  action?: { label: string; onPick: () => void; primary?: boolean; danger?: boolean; disabled?: boolean }
  menu?: MenuItem[]
  /** Accessible name of the ⋯ button (menus are otherwise unlabelled). */
  menuLabel?: string
  /** Escape hatch for the rare row that must say something extra inline. */
  extra?: unknown
}

export function kit(React: ReactLike) {
  const h = React.createElement

  /**
   * The ⋯ overflow menu. Its popover is position:FIXED so that the settings
   * pane's own overflow:auto cannot clip it — the last row's menu used to be
   * the one you could not read. Fixed positioning does not follow scrolling,
   * so a scroll dismisses the menu, which is what a native menu does anyway.
   */
  const MenuView = view<{ items: MenuItem[]; label: string }>(React, (props) => {
    const [at, setAt] = React.useState<{ top?: number; bottom?: number; right: number } | undefined>(undefined)
    React.useEffect(() => {
      if (at === undefined || typeof document === 'undefined') return
      const close = (): void => setAt(undefined)
      const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close() }
      document.addEventListener('mousedown', close)
      document.addEventListener('keydown', onKey)
      window.addEventListener('scroll', close, true)
      return () => {
        document.removeEventListener('mousedown', close)
        document.removeEventListener('keydown', onKey)
        window.removeEventListener('scroll', close, true)
      }
    }, [at])
    const toggleOpen = (event?: unknown): void => {
      if (at !== undefined) { setAt(undefined); return }
      const el = (event as { currentTarget?: { getBoundingClientRect?: () => DOMRect } } | undefined)?.currentTarget
      const r = el?.getBoundingClientRect?.()
      if (r === undefined || typeof window === 'undefined') { setAt({ top: 0, right: 0 }); return }
      const right = Math.max(8, window.innerWidth - r.right)
      // Flip upward when the menu would run off the bottom of the window.
      const needed = 16 + props.items.length * 30
      return r.bottom + needed > window.innerHeight
        ? setAt({ bottom: window.innerHeight - r.top + 4, right })
        : setAt({ top: r.bottom + 4, right })
    }
    return h('div', { className: 'mmc-trailmenu' },
      h('button', {
        type: 'button', className: 'mmc-more', 'aria-label': props.label,
        'aria-haspopup': 'menu', 'aria-expanded': at !== undefined ? 'true' : 'false',
        onClick: (event: unknown) => toggleOpen(event),
      }, '⋯'),
      at === undefined ? null : h('div', {
        className: 'mmc-menu', role: 'menu',
        // The dismiss listener is on mousedown, so the popover must not let a
        // press inside it reach the document or the click never lands.
        onMouseDown: (e: { stopPropagation?: () => void }) => { e.stopPropagation?.() },
        style: {
          right: String(at.right) + 'px',
          ...(at.top !== undefined ? { top: String(at.top) + 'px' } : {}),
          ...(at.bottom !== undefined ? { bottom: String(at.bottom) + 'px' } : {}),
        },
      }, props.items.map((item, i) => h('button', {
        key: String(i) + item.label, type: 'button', role: 'menuitem', className: 'mmc-mi',
        disabled: item.disabled === true,
        ...(item.danger === true ? { 'data-danger': 'true' } : {}),
        onClick: () => { setAt(undefined); item.onPick() },
      }, item.label))),
    )
  })

  const btn = (label: string, onClick: () => void, opts: { primary?: boolean; danger?: boolean; disabled?: boolean; title?: string; key?: string; wide?: boolean; plain?: boolean } = {}) =>
    h('button', {
      type: 'button',
      key: opts.key,
      className: 'mmc-btn',
      disabled: opts.disabled === true,
      'aria-label': opts.title ?? label,
      ...(opts.primary === true ? { 'data-primary': 'true' } : {}),
      ...(opts.danger === true ? { 'data-danger': 'true' } : {}),
      ...(opts.wide === true ? { 'data-wide': 'true' } : {}),
      ...(opts.plain === true ? { 'data-plain': 'true' } : {}),
      onClick,
    }, label)
  const tag = (text: string, tone: boolean | Tone = false, key?: string, title?: string) =>
    h('span', {
      key,
      className: 'mmc-tag',
      ...(title !== undefined ? { title } : {}),
      ...(tone === false ? {} : { 'data-tone': tone === true ? 'warn' : tone }),
    }, text)
  const note = (text: string) => h('div', { className: 'mmc-note' }, text)
  const error = (text: string) => h('div', { className: 'mmc-error' }, text)
  const input = (props: Record<string, unknown>) => h('input', { className: 'mmc-input', ...props })
  const textarea = (props: Record<string, unknown>) => h('textarea', { className: 'mmc-input', ...props })
  const card = (...children: unknown[]) => h('div', { className: 'mmc-card' }, ...children)
  const dot = (state: 'ok' | 'off' | 'bad') => h('span', { className: 'mmc-dot', 'data-ok': state === 'ok' ? 'true' : undefined, 'data-off': state === 'off' ? 'true' : undefined })
  /** A right-aligned button group. For a page or a form — never for a row. */
  const actions = (...children: unknown[]) => h('div', { className: 'mmc-actions' }, ...children)
  /**
   * An on/off switch: ONE control that shows the current state and changes it.
   * The pair of "Enable"/"Disable" buttons it replaces had to be read before
   * it could be understood — the label named the action, so the state was
   * whatever the label was not.
   */
  const toggle = (on: boolean, onChange: (next: boolean) => void, opts: { label?: string; disabled?: boolean; key?: string } = {}) =>
    h('button', {
      key: opts.key, type: 'button', role: 'switch', className: 'mmc-sw',
      'aria-checked': on ? 'true' : 'false',
      'aria-label': opts.label,
      disabled: opts.disabled === true,
      onClick: () => onChange(!on),
    })
  /**
   * The fact line of a row: everything that is NOT identity, joined into ONE
   * grey string. Four bordered chips read as four buttons — the eye parses
   * each border before it reads a word.
   */
  const factsOf = (...parts: Array<string | false | null | undefined>) =>
    parts.filter((x): x is string => typeof x === 'string' && x !== '').join(' · ')
  const facts = (...parts: Array<string | false | null | undefined>) => {
    const text = factsOf(...parts)
    return text === '' ? null : h('span', { className: 'mmc-meta', title: text }, text)
  }
  /** The rounded group a list of rows lives in. */
  const rows = (...children: unknown[]) => h('div', { className: 'mmc-rows' }, ...children)
  /** One row. See RowSpec: the trailing area is a switch, a button, or a menu. */
  const row = (spec: RowSpec) => {
    const tap = spec.onOpen
    return h('div', {
      key: spec.key ?? spec.name,
      className: 'mmc-r',
      ...(spec.open === true ? { 'data-open': 'true' } : {}),
      ...(spec.state === 'off' ? { 'data-off': 'true' } : {}),
      ...(tap !== undefined ? { 'data-tap': 'true' } : {}),
    },
      spec.icon !== undefined ? iconOf(React, spec.icon) : null,
      spec.state !== undefined && (spec.icon === undefined || spec.state === 'bad') ? dot(spec.state) : null,
      tap !== undefined
        ? h('button', {
            type: 'button', className: 'mmc-open', title: spec.name, 'aria-label': spec.name,
            ...(spec.open !== undefined ? { 'aria-expanded': spec.open ? 'true' : 'false' } : {}),
            onClick: tap,
          }, h('span', { className: 'mmc-name' }, spec.name))
        : h('span', { className: 'mmc-name', title: spec.name }, spec.name),
      spec.badge !== undefined ? tag(spec.badge.text, spec.badge.tone ?? 'info', 'badge') : null,
      spec.meta !== undefined && spec.meta !== '' ? h('span', { className: 'mmc-meta', title: spec.meta }, spec.meta) : null,
      spec.extra ?? null,
      h('div', { className: 'mmc-trail' },
        spec.toggle !== undefined
          ? toggle(spec.toggle.on, spec.toggle.onChange, { key: 'sw', label: spec.toggle.label ?? spec.name, disabled: spec.toggle.disabled })
          : null,
        spec.action !== undefined
          ? btn(spec.action.label, spec.action.onPick, {
              key: 'act',
              ...(spec.action.primary === true ? { primary: true } : {}),
              ...(spec.action.danger === true ? { danger: true } : {}),
              ...(spec.action.disabled === true ? { disabled: true } : {}),
            })
          : null,
        spec.menu !== undefined && spec.menu.length > 0
          ? h(MenuView, { key: 'menu', items: spec.menu, label: spec.menuLabel ?? spec.name })
          : null,
        tap !== undefined ? h('span', { className: 'mmc-chev', ...(spec.open === true ? { 'data-open': 'true' } : {}) }, '›') : null,
      ),
    )
  }
  /**
   * The empty state of a collection. Rendered INSTEAD of the group, never
   * inside it: an empty group is a bordered box drawn around one grey
   * sentence.
   */
  const empty = (text: string, ...children: unknown[]) =>
    h('div', { className: 'mmc-empty' }, h('span', {}, text), ...children)
  /** Explanatory text BELOW a group, the way a settings footnote reads. */
  const footnote = (text: string) => h('div', { className: 'mmc-foot' }, text)
  /**
   * A labelled group: a short label and the group's actions above the
   * content, and `sub` as a FOOTNOTE below it. Prose belongs under the thing
   * it explains, not wedged between the title and the buttons.
   */
  const section = (label: string, opts: { sub?: string; actions?: unknown[] }, ...children: unknown[]) => {
    const sub = opts.sub ?? ''
    const acts = (opts.actions ?? []).filter((a) => a !== null && a !== undefined)
    return h('div', { className: 'mmc-section' },
      h('div', { className: 'mmc-shead' },
        h('div', { className: 'mmc-label' }, label),
        acts.length > 0 ? h('div', { className: 'mmc-actions' }, ...acts) : null),
      ...children,
      sub !== '' ? footnote(sub) : null)
  }
  /** The one page header: a line of context plus the page's actions. */
  const head = (sub: string, ...children: unknown[]) =>
    h('div', { className: 'mmc-head' },
      sub !== '' ? h('span', { className: 'mmc-sub' }, sub) : null,
      children.length > 0 ? h('div', { className: 'mmc-actions' }, ...children) : null)
  /** The header of a drilled-in view: back out, then the thing's identity. */
  const back = (label: string, onBack: () => void, opts: { icon?: string } = {}, ...children: unknown[]) =>
    h('div', { className: 'mmc-head' },
      h('div', { className: 'mmc-back' },
        btn('‹', onBack, { plain: true, title: label, key: 'back' }),
        opts.icon !== undefined ? iconOf(React, opts.icon) : null,
        h('div', { className: 'mmc-label' }, label)),
      children.length > 0 ? h('div', { className: 'mmc-actions' }, ...children) : null)
  /** A segmented control. Active key in state owned by the caller. */
  const tabs = (items: Array<{ key: string; label: string }>, active: string, onPick: (key: string) => void) =>
    h('div', { className: 'mmc-tabs', role: 'tablist' }, items.map((x) =>
      h('button', {
        key: x.key, type: 'button', role: 'tab', className: 'mmc-tab',
        'aria-selected': x.key === active ? 'true' : 'false',
        'data-active': x.key === active ? 'true' : undefined,
        onClick: () => onPick(x.key),
      }, x.label)))
  /** The type tile on its own, for headers that are not list rows. */
  const icon = (type: string, title?: string) => iconOf(React, type, title)
  /** A ⋯ menu on its own, for headers that are not list rows. */
  const menu = (items: MenuItem[], label: string, key = 'menu') => h(MenuView, { key, items, label })
  const kv = (k: string, v: unknown) => h('div', { className: 'mmc-kv' }, h('span', {}, k), h('span', {}, String(v)))
  const mono = (text: string) => h('pre', { className: 'mmc-monospace' }, text)
  const select = (props: Record<string, unknown>, ...children: unknown[]) => h('select', { className: 'mmc-input', ...props }, ...children)
  return {
    h, btn, tag, note, error, input, textarea, card, dot, icon, menu, actions, toggle,
    rows, row, empty, footnote, section, head, back, facts, factsOf, tabs, kv, mono, select,
  }
}

export type Kit = ReturnType<typeof kit>

/**
 * Wrap a render callback in a STABLE component identity. The pages in this
 * plugin are plain functions taking (React, kit, ...) and calling hooks —
 * invoking them directly as conditional children puts their hooks in the
 * PARENT's render and breaks hook order when the condition flips (React:
 * "Rendered more hooks than during the previous render"). Rendering
 * view(React, render) through createElement gives the subtree its own
 * component instance, so mounting and unmounting it is always legal.
 *
 * Create the wrapper ONCE per (React, kit) binding — never inside another
 * component's render — or its identity changes every render and React
 * remounts (losing) the subtree state.
 */
export function view<P extends Record<string, unknown>>(React: ReactLike, render: (props: P) => unknown): (props: P) => unknown {
  void React
  return function DshMcpView(props: P): unknown {
    return render(props)
  }
}
