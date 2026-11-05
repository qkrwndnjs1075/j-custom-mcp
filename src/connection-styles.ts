export const CONNECTION_STYLES = `
:root {
  color-scheme: light dark;
  --canvas: #f5f6f3; --surface: #ffffff; --wash: #eef2ed;
  --ink: #172b23; --muted: #536159; --line: #d5ddd6;
  --action: #244d39; --action-hover: #163726; --on-action: #ffffff;
  --error: #9b2934; --error-wash: #fff0f1; --focus: #286ac7;
  --text-sm: 14px; --text-base: 16px; --text-lg: 18px; --text-title: 28px;
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 20px;
  --s6: 24px; --s8: 32px; --s10: 40px; --s12: 48px;
  --measure: 480px; --control: 52px; --check: 22px;
  --radius-panel: 20px; --radius-control: 10px; --radius-notice: 10px;
  font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
  font-size: var(--text-base); line-height: 1.65;
  color: var(--ink); background: var(--canvas);
}
* { box-sizing: border-box; }
body { margin: 0; min-block-size: 100dvh; }
h1, h2, p, ol, ul, dl, dd { margin: 0; }
button, input { font: inherit; }
a { color: var(--action); text-underline-offset: var(--s1); }
a:hover { color: var(--action-hover); }
button, a, summary { -webkit-tap-highlight-color: transparent; }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
.shell { max-inline-size: calc(var(--measure) + var(--s10)); margin-inline: auto; padding: var(--s8) var(--s5) var(--s6); }
.masthead { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s3); padding: 0 var(--s1) var(--s6); }
.brand { font-size: var(--text-lg); font-weight: 700; letter-spacing: -0.035em; }
.masthead-label { font-size: var(--text-sm); color: var(--muted); }
main { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-panel); padding: var(--s6); }
.intro { margin-block-end: var(--s8); }
h1 { font-size: var(--text-title); line-height: 1.35; letter-spacing: -0.035em; font-weight: 700; margin-block: var(--s6) var(--s3); }
h2 { font-size: var(--text-base); line-height: 1.5; font-weight: 600; }
p, h1, h2, li, label { word-break: keep-all; overflow-wrap: anywhere; }
.description { color: var(--muted); }
.steps { display: flex; flex-wrap: wrap; gap: var(--s3); list-style: none; padding: 0; color: var(--muted); font-size: var(--text-sm); }
.steps li { display: flex; align-items: center; gap: var(--s1); }
.steps span { display: inline-grid; place-items: center; inline-size: var(--s6); block-size: var(--s6); border-radius: var(--radius-control); background: var(--wash); }
.steps [aria-current] { font-weight: 700; color: var(--ink); }
.steps [aria-current] span { color: var(--on-action); background: var(--action); }
.eyebrow { font-size: var(--text-sm); font-weight: 600; color: var(--muted); }
.content, .form-stack { display: flex; flex-direction: column; gap: var(--s6); }
.field { display: flex; flex-direction: column; gap: var(--s2); }
.field label { font-weight: 600; }
.field input { min-block-size: var(--control); inline-size: 100%; min-inline-size: 0; border: 1px solid var(--line); border-radius: var(--radius-control); padding: var(--s3) var(--s4); color: var(--ink); background: var(--surface); }
.field input:user-invalid { border-color: var(--error); }
.hint { color: var(--muted); font-size: var(--text-sm); }
.button { inline-size: 100%; min-block-size: var(--control); padding: var(--s3) var(--s4); border: 1px solid transparent; border-radius: var(--radius-control); background: var(--action); color: var(--on-action); font-weight: 600; cursor: pointer; word-break: keep-all; overflow-wrap: anywhere; }
.button:hover { background: var(--action-hover); }
a.button { display: flex; align-items: center; justify-content: center; text-align: center; text-decoration: none; }
.button:active, a:active { opacity: 0.8; }
.button:disabled { opacity: 0.5; cursor: not-allowed; }
.button.secondary { background: var(--surface); border-color: var(--line); color: var(--ink); }
.button.secondary:hover { background: var(--wash); }
.context, .notice { padding: var(--s4); background: var(--wash); border-radius: var(--radius-notice); }
.context h2 { margin-block-end: var(--s3); }
dt { margin-block-start: var(--s3); font-size: var(--text-sm); color: var(--muted); }
dd { font-size: var(--text-sm); overflow-wrap: anywhere; }
.scope ul { padding-inline-start: var(--s5); margin-block: var(--s3); }
fieldset { margin: 0; padding: 0; border: 0; min-inline-size: 0; }
legend { padding: 0; font-weight: 600; margin-block-end: var(--s2); }
.check-row { display: flex; gap: var(--s3); align-items: flex-start; min-block-size: var(--control); padding-block: var(--s3); cursor: pointer; }
.check-row input { flex: 0 0 var(--check); inline-size: var(--check); block-size: var(--check); margin: var(--s1) 0 0; accent-color: var(--action); }
.terms { display: inline-block; padding-block: var(--s3); font-size: var(--text-sm); }
.terms span { white-space: nowrap; }
.notice { font-size: var(--text-sm); }
.notice.error { color: var(--error); background: var(--error-wash); margin-block-end: var(--s6); }
.status-title { font-weight: 600; margin-block-end: var(--s2); font-size: var(--text-base); }
.instructions { padding-inline-start: var(--s5); }
.instructions li + li { margin-block-start: var(--s3); }
.disconnect { border-block-start: 1px solid var(--line); padding-block-start: var(--s3); }
summary { min-block-size: var(--control); padding-block: var(--s3); cursor: pointer; font-size: var(--text-sm); color: var(--muted); }
summary:hover { color: var(--ink); }
.disconnect p { margin-block: var(--s2) var(--s4); }
footer { text-align: center; padding: var(--s6) var(--s2) 0; font-size: var(--text-sm); color: var(--muted); }
.skip-link { position: absolute; inset-inline-start: var(--s4); inset-block-start: var(--s4); padding: var(--s3); background: var(--surface); transform: translateY(-200%); }
.skip-link:focus { transform: translateY(0); }
@media (min-width: 640px) { .shell { padding-block-start: var(--s12); } }
@media (max-width: 359px) { main { padding: var(--s5); } }
@media (prefers-color-scheme: dark) {
  :root { --canvas: #141917; --surface: #1c2420; --wash: #26342c;
    --ink: #edf3ee; --muted: #b3c2b8; --line: #4d6053;
    --action: #b9dfc3; --action-hover: #d1eed8; --on-action: #172b23;
    --error: #ffc0c7; --error-wash: #3c242a; --focus: #92baff; }
}
@media (forced-colors: active) { .button { border-color: ButtonText; } }
`;
