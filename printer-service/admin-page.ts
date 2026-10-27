/** Shared look for the tailnet admin pages: the same tokens, header and page tabs. */
export const adminStyles = `@font-face{font-family:Poppins;src:url('/fonts/poppins-400.ttf') format('truetype');font-weight:400;font-display:swap}
@font-face{font-family:Poppins;src:url('/fonts/poppins-500.ttf') format('truetype');font-weight:500;font-display:swap}
@font-face{font-family:Poppins;src:url('/fonts/poppins-600.ttf') format('truetype');font-weight:600;font-display:swap}
@font-face{font-family:Poppins;src:url('/fonts/poppins-700.ttf') format('truetype');font-weight:700;font-display:swap}
:root{--olive-900:#3d3a2b;--olive-800:#4a4733;--olive-700:#5f5b40;--olive-300:#aaa68e;--olive-100:#d9d6c6;--cream-100:#f6f1e4;--cream-200:#ede5d3;--cream-300:#e2d8c3;--paper-100:#ddd6cc;--ink-700:#2b2921;--ink-500:#55523f;--rust-600:#a3492f;--moss-600:#6b7a4a;--alert-bg:#f3e0d8;--alert-ink:#6e2d1b;--focus-ring:rgba(95,91,64,.45);--shadow-card:0 2px 6px rgba(61,58,43,.08),0 12px 28px rgba(61,58,43,.1);--radius-card:16px;--radius-input:10px;--font-sans:'Poppins','Helvetica Neue',sans-serif;--font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-family:var(--font-sans);color:var(--ink-700);background:var(--cream-200)}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column}
header{height:64px;flex-shrink:0;padding:0 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--olive-700)}
.brand{display:flex;align-items:center;gap:14px}
.brand img{display:block;height:30px;width:auto}
.divider{width:1px;height:26px;background:rgba(237,229,211,.3)}
h1{margin:0;font:600 13px/1 var(--font-sans);letter-spacing:.24em;text-transform:uppercase;color:var(--cream-200)}
.host{display:none;font:500 13px/1 var(--font-sans);color:var(--cream-300)}
main{flex-grow:1;padding:24px 16px 32px}
.column{max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.card{padding:20px;border-radius:var(--radius-card);background:var(--cream-100);box-shadow:var(--shadow-card);display:flex;flex-direction:column;gap:16px}
.top{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.badge{display:inline-flex;align-items:center;padding:4px 12px;border-radius:999px;font:600 12px/1.4 var(--font-sans);letter-spacing:.13em;text-transform:uppercase;background:var(--olive-100);color:var(--olive-900)}
.badge.active{background:var(--moss-600);color:var(--cream-100)}
.badge.unavailable{background:var(--rust-600);color:var(--cream-100)}
.badge.busy{background:var(--olive-700);color:var(--cream-200)}
.status{display:flex;flex-direction:column;gap:6px}
h2{margin:0;color:var(--olive-900)}
.status h2{font:700 26px/1.2 var(--font-sans);letter-spacing:-.015em}
p{margin:0}
.detail{font:400 15px/1.55 var(--font-sans)}
.small{font:400 13px/1.5 var(--font-sans);color:var(--ink-500)}
.actions{display:flex;flex-wrap:wrap;gap:10px}
.actions>*{flex:1 1 220px;min-width:0}
.row{display:flex;flex-wrap:wrap;gap:8px}
button{min-height:44px;padding:0 20px;border:2px solid transparent;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;gap:6px;font:600 12px/1 var(--font-sans);letter-spacing:.13em;text-transform:uppercase;cursor:pointer;background:transparent;color:var(--olive-800)}
button:focus-visible{outline:3px solid var(--focus-ring);outline-offset:2px}
button:disabled{opacity:.45;cursor:default}
button.primary{background:var(--olive-700);color:var(--cream-200)}
button.primary:hover:not(:disabled){background:var(--olive-800)}
button.secondary{border-color:var(--olive-700)}
button.secondary:hover:not(:disabled),button.ghost:hover:not(:disabled){background:var(--olive-100)}
button.danger{border-color:var(--rust-600);color:var(--rust-600)}
button.danger-solid{background:var(--rust-600);color:var(--cream-100)}
button.large{min-height:52px;font-size:14px}
button.link{padding:0 10px;font-size:13px;letter-spacing:0;text-transform:none}
.eyebrow{font:600 12px/1.4 var(--font-sans);letter-spacing:.26em;text-transform:uppercase;color:var(--ink-500)}
.code-box{padding:18px 12px;border-radius:var(--radius-input);border:2px dashed var(--olive-300);background:var(--cream-200);display:flex;justify-content:center}
.code{font:700 34px/1.1 var(--font-mono);letter-spacing:.12em;color:var(--olive-900);overflow-wrap:anywhere;text-align:center}
.code .dash{color:var(--olive-300);padding:0 4px}
.expiry{font:500 15px/1.5 var(--font-sans);color:var(--olive-900)}
.body{font:400 14px/1.55 var(--font-sans)}
.note{padding:10px 12px;border-radius:var(--radius-input);display:flex;gap:10px;align-items:flex-start;font:500 14px/1.5 var(--font-sans);background:var(--olive-100);color:var(--olive-900)}
.note svg,.footnote svg,.alert-title svg{flex-shrink:0;margin-top:1px}
.note.failed{background:var(--alert-bg);border:1.5px solid var(--rust-600);color:var(--alert-ink)}
.note.failed svg{color:var(--rust-600)}
.notice{padding:14px 16px;border-radius:var(--radius-card);font-size:15px}
.alert{padding:18px;border-radius:var(--radius-card);background:var(--alert-bg);border:1.5px solid var(--rust-600);display:flex;flex-direction:column;gap:12px;color:var(--alert-ink)}
.alert-title{display:flex;gap:10px;align-items:center;font:700 17px/1.3 var(--font-sans);color:var(--alert-ink)}
.alert-title svg{color:var(--rust-600)}
.alert button{align-self:flex-start}
.footnote{margin:4px 4px 0;display:flex;gap:8px;align-items:flex-start;font:400 13px/1.55 var(--font-sans);color:var(--ink-500)}
.footnote svg{margin-top:3px}
dialog{width:calc(100% - 32px);max-width:420px;border:0;border-radius:var(--radius-card);padding:24px;background:var(--cream-100);color:var(--ink-700);box-shadow:var(--shadow-card)}
dialog::backdrop{background:rgba(18,16,12,.45)}
dialog h2{font:700 22px/1.25 var(--font-sans)}
dialog form{display:flex;flex-direction:column;gap:14px}
dialog .detail{margin:0}
.devices{padding:10px 12px;border-radius:var(--radius-input);background:var(--paper-100);font:600 14px/1.45 var(--font-sans)}
dialog .row{justify-content:flex-end;margin-top:4px}
.mint{display:flex;flex-direction:column;gap:10px}
.mint label{font:600 15px/1.45 var(--font-sans);color:var(--olive-900)}
.mint-row{display:flex;gap:10px;align-items:stretch}
.count{width:88px;min-height:52px;flex-shrink:0;border:2px solid var(--olive-300);border-radius:var(--radius-input);background:var(--cream-200);color:var(--olive-900);text-align:center;font:700 26px/1 var(--font-sans)}
.count:focus-visible{outline:3px solid var(--focus-ring);outline-offset:2px;border-color:var(--olive-700)}
.mint-row button{flex:1 1 auto;min-width:0}
.print-option{display:flex;align-items:center;gap:12px;min-height:44px;font:600 15px/1.45 var(--font-sans);color:var(--olive-900)}
.print-option input{width:24px;height:24px;flex-shrink:0;margin:0;accent-color:var(--olive-700)}
.print-option input:focus-visible{outline:3px solid var(--focus-ring);outline-offset:2px}
.codes,.items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.minted{display:flex;flex-direction:column;gap:10px;padding-bottom:12px;border-bottom:1px solid var(--cream-300)}
.minted:last-child{padding-bottom:0;border-bottom:0}
.minted-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.item{padding:12px 14px;border-radius:var(--radius-input);background:var(--cream-200);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.who{display:flex;flex-direction:column;gap:2px;min-width:0}
.who .name{font:600 15px/1.4 var(--font-sans);color:var(--olive-900);overflow-wrap:anywhere}
#everyone{align-self:flex-start}
[hidden]{display:none!important}
@media (min-width:640px){.host{display:inline}}
.tabs{display:flex;gap:4px;padding:0 12px;background:var(--olive-800)}
.tabs a{min-height:44px;padding:0 16px;display:inline-flex;align-items:center;border-bottom:3px solid transparent;font:600 12px/1 var(--font-sans);letter-spacing:.13em;text-transform:uppercase;text-decoration:none;color:var(--cream-300)}
.tabs a[aria-current=page]{border-bottom-color:var(--cream-200);color:var(--cream-100)}
.tabs a:hover{color:var(--cream-100)}
.tabs a:focus-visible{outline:3px solid var(--focus-ring);outline-offset:-3px}
.field{display:flex;flex-direction:column;gap:6px;min-width:0}
.field label{font:600 15px/1.45 var(--font-sans);color:var(--olive-900)}
.field input,.field select,.field textarea{width:100%;min-height:48px;padding:10px 12px;border:2px solid var(--olive-300);border-radius:var(--radius-input);background:var(--cream-200);color:var(--olive-900);font:500 16px/1.4 var(--font-sans)}
.field textarea{min-height:76px;resize:vertical}
.field input:focus-visible,.field select:focus-visible,.field textarea:focus-visible{outline:3px solid var(--focus-ring);outline-offset:2px;border-color:var(--olive-700)}
.add{display:flex;flex-direction:column;gap:14px}
.choice-buttons{display:flex;gap:6px;flex-wrap:wrap}
button.icon{min-width:44px;padding:0 12px;font-size:16px;letter-spacing:0}
.desc{font:400 13px/1.5 var(--font-sans);color:var(--ink-500);overflow-wrap:anywhere}
`;

const pages = [
  { href: '/', label: 'Access codes' },
  { href: '/menu', label: 'Menu' },
] as const;

/** One admin page; `body` and `script` are trusted markup built by this service. */
export function adminDocument({
  nonce,
  host,
  title,
  body,
  script,
}: {
  nonce: string;
  host: string;
  title: (typeof pages)[number]['label'];
  body: string;
  script: string;
}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · Order Pad</title>
<style nonce="${nonce}">
${adminStyles}</style>
</head>
<body>
<header>
<span class="brand"><img src="/logo.svg" alt="Fiona’s Ice Cream" width="56" height="30"><span class="divider" aria-hidden="true"></span><h1>${title}</h1></span>
<span class="host">${host}</span>
</header>
<nav class="tabs" aria-label="Admin pages">${pages
    .map(
      (page) =>
        `<a href="${page.href}"${page.label === title ? ' aria-current="page"' : ''}>${page.label}</a>`,
    )
    .join('')}</nav>
${body}<script nonce="${nonce}">
${script}</script>
</body>
</html>
`;
}
