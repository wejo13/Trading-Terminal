<style>
  /* ===================== DESIGN TOKENS ===================== */
  /* Palette sampled directly from the Selimor dashboard reference - background,
     panel, card, and teal accent are exact pixel reads, not approximations.
     Gain/loss + above/below-EMA semantic colors also intentionally match
     Selimor's muted tones (cosmetic match, per explicit decision), rather than
     reusing the old app's punchier neon green/red. */
  :root{
    --bg:#07060c;             /* outer/sidebar background */
    --panel:#2d2c32;          /* main content panel background */
    --card:#211f26;           /* card surface */
    --card-hover:#28262e;
    --line:#1c1b21;           /* hairline borders/dividers */
    --text:#f0f2f4;           /* primary text */
    --text-dim:#9aa0a6;       /* secondary/muted text */
    --text-faint:#6b7178;     /* tertiary labels, sidebar section headers */
    --teal:#28d7c8;           /* primary accent */
    --teal-dim:#1a4a3a;       /* accent tint background (icon badges, success bg) */
    --green:#3ddc97;          /* gains / above-EMA */
    --green-dim:#1a3a2e;
    --red:#e2645f;            /* losses / below-EMA */
    --red-dim:#3a2226;
    --amber:#d9a93f;
    --amber-dim:#3a2f1a;
    --violet:#9b8ae8;
    --violet-dim:#2a2440;
    --font: 'Inter','Segoe UI',Arial,sans-serif;
    --radius-card:14px;
    --radius-pill:20px;

    /* ----- legacy aliases -----
       The watchlist/chart-modal/alerts CSS (ported as-is from the old single-file
       app) references these older token names throughout. Rather than rewrite
       every rule, these aliases point the old names at the new Selimor tokens
       above, so the inherited CSS resolves correctly without modification. New
       code written going forward should use the tokens above directly, not these
       aliases - this block exists purely as a migration bridge and can be deleted
       once nothing in the ported CSS references the old names anymore. */
    --panel: var(--card);
    --line: var(--line-old);
    --line-old:#2f2e35;
    --dim: var(--text-dim);
    --mono: var(--font);

    /* ----- bg/border aliases used in new tabs -----
       --bg1 = slightly lighter than bg (card surface)
       --bg2 = input/field background (slightly lighter than card)
       --border = standard hairline border colour
       --border-bright = highlighted border for active states */
    --bg1: var(--card);
    --bg2: #2a2830;
    --border: #2f2e35;
    --border-bright: #4a4855;
  }
  *{box-sizing:border-box;}
  body{
    margin:0;
    background:var(--bg);
    color:var(--text);
    font-family:var(--font);
    -webkit-font-smoothing:antialiased;
  }
  a{color:inherit;}

  /* ===================== APP SHELL ===================== */
  .app-shell{
    display:flex;
    min-height:100vh;
  }

  /* ----- sidebar ----- */
  .sidebar{
    width:220px;
    flex-shrink:0;
    background:var(--bg);
    border-right:1px solid var(--line);
    display:flex;
    flex-direction:column;
    padding:20px 0;
    position:sticky;
    top:0;
    height:100vh;
  }
  .sidebar-brand{
    padding:0 20px 18px;
    border-bottom:1px solid var(--line);
    margin-bottom:16px;
  }
  .sidebar-brand-title{
    font-size:15px;font-weight:600;color:var(--text);letter-spacing:-0.2px;
  }
  .sidebar-brand-title span{color:var(--teal);}

  .sidebar-section-label{
    padding:0 20px;font-size:10px;color:var(--text-faint);
    letter-spacing:0.5px;margin:18px 0 8px;text-transform:uppercase;
  }
  .sidebar-section-label:first-of-type{margin-top:0;}

  .nav-item{
    display:flex;align-items:center;gap:10px;
    padding:10px 20px;margin-right:16px;
    cursor:pointer;color:var(--text-dim);font-size:13px;font-weight:500;
    border-radius:0 var(--radius-pill) var(--radius-pill) 0;
    transition:background 0.12s,color 0.12s;
    user-select:none;
  }
  .nav-item:hover{color:var(--text);background:rgba(255,255,255,0.04);}
  .nav-item.active{
    color:var(--bg);background:var(--teal);font-weight:600;
  }
  .nav-item.active:hover{background:var(--teal);}
  .nav-item i{font-size:17px;flex-shrink:0;}
  .nav-item.disabled{opacity:0.4;cursor:default;}
  .nav-item.disabled:hover{background:transparent;color:var(--text-dim);}

  /* sidebar sub-items (indented children under a parent nav group) */
  .nav-group-label{
    display:flex;align-items:center;gap:10px;
    padding:10px 20px 6px;color:var(--text-faint);font-size:12px;font-weight:500;
    user-select:none;cursor:default;
  }
  .nav-group-label i{font-size:17px;flex-shrink:0;}
  .nav-sub-item{
    display:flex;align-items:center;gap:8px;
    padding:7px 20px 7px 44px;margin-right:16px;
    cursor:pointer;color:var(--text-faint);font-size:12px;font-weight:400;
    border-radius:0 var(--radius-pill) var(--radius-pill) 0;
    transition:background 0.12s,color 0.12s;
    user-select:none;
  }
  .nav-sub-item:hover{color:var(--text);background:rgba(255,255,255,0.04);}
  .nav-sub-item.active{
    color:var(--bg);background:var(--teal);font-weight:600;
  }
  .nav-sub-item.active:hover{background:var(--teal);}
  .nav-sub-dot{
    width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0;opacity:0.6;
  }

  .sidebar-footer{
    margin-top:auto;padding:0 20px;
  }
  .sidebar-footer .nav-item{
    border-top:1px solid var(--line);padding-top:16px;margin-top:8px;
    border-radius:0;margin-right:0;padding-left:0;padding-right:0;
  }
  .sidebar-footer .nav-item:hover{background:transparent;color:var(--text);}

  /* ----- main content area ----- */
  .main{
    flex:1;
    background:var(--panel);
    padding:24px 28px 60px;
    min-width:0;
  }
  .main-header{
    display:flex;justify-content:space-between;align-items:center;
    margin-bottom:20px;
  }
  .main-title{
    font-size:19px;font-weight:600;color:var(--text);
  }
  .live-pill{
    font-size:12px;color:var(--text-dim);background:var(--card);
    padding:5px 13px;border-radius:var(--radius-pill);
    display:flex;align-items:center;gap:6px;
  }
  .live-pill .dot{
    width:6px;height:6px;border-radius:50%;background:var(--teal);
    box-shadow:0 0 6px rgba(40,215,200,0.6);
  }

  /* generic card, used across all tabs */
  .card{
    background:var(--card);border-radius:var(--radius-card);padding:16px;
  }

  /* ----- placeholder tab styling (used by tabs not yet built) ----- */
  .placeholder-tab{
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    text-align:center;padding:80px 20px;color:var(--text-dim);
    background:var(--card);border-radius:var(--radius-card);
    min-height:300px;
  }
  .placeholder-tab i{font-size:32px;color:var(--text-faint);margin-bottom:14px;}
  .placeholder-tab .ph-title{font-size:15px;font-weight:600;color:var(--text);margin-bottom:6px;}
  .placeholder-tab .ph-sub{font-size:13px;color:var(--text-dim);max-width:360px;line-height:1.5;}

  /* ----- tab view container ----- */
  .tab-view{display:none;}
  .tab-view.active{display:block;}

  /* ===== GRID BOT ===== */
  .grid-bot-layout{display:grid;grid-template-columns:340px 1fr;gap:14px;align-items:start;}
  @media(max-width:900px){.grid-bot-layout{grid-template-columns:1fr;}}
  .grid-left-col,.grid-right-col{display:flex;flex-direction:column;gap:12px;}
  .grid-card{
    background:var(--card);border-radius:var(--radius-card);padding:18px;
    border:0.5px solid var(--line-old);
  }
  .grid-viz-card{padding:18px 14px;}
  .grid-card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
  .grid-card-title{font-size:12px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.4px;display:flex;align-items:center;gap:6px;}
  .grid-card-title i{font-size:14px;color:var(--teal);}
  .grid-status-badge{
    font-size:9px;font-weight:700;letter-spacing:0.5px;padding:3px 9px;
    border-radius:4px;background:rgba(255,255,255,0.06);color:var(--text-faint);border:1px solid var(--line-old);
  }
  .grid-status-badge.running{background:var(--teal-dim);color:var(--teal);border-color:rgba(40,215,200,0.35);}
  .grid-status-badge.paused{background:var(--amber-dim);color:var(--amber);border-color:rgba(217,169,63,0.35);}
  .grid-status-badge.stopped{background:var(--red-dim);color:var(--red);border-color:rgba(226,100,95,0.35);}
  .grid-market-pill{
    font-size:12px;font-weight:600;color:var(--teal);
    background:var(--teal-dim);border-radius:var(--radius-pill);
    padding:5px 14px;display:inline-flex;align-items:center;gap:6px;
    border:1px solid rgba(40,215,200,0.2);
  }
  .grid-field-row{margin-bottom:12px;}
  .grid-inputs{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;}
  .grid-field{display:flex;flex-direction:column;gap:4px;}
  .grid-label{font-size:10px;color:var(--text-dim);font-weight:500;letter-spacing:0.3px;}
  .grid-label-hint{color:var(--text-faint);}
  .grid-input{
    background:rgba(255,255,255,0.04);border:1px solid var(--line-old);
    border-radius:8px;padding:8px 10px;color:var(--text);font-size:13px;
    font-family:var(--font);outline:none;transition:border-color 0.15s;width:100%;
  }
  .grid-input:focus{border-color:var(--teal);}
  .grid-input::placeholder{color:var(--text-faint);}
  .grid-leverage-info{font-size:10px;color:var(--text-faint);line-height:1.4;margin-top:5px;}
  .grid-leverage-info strong{color:var(--teal);}
  .grid-leverage-slider{
    -webkit-appearance:none;appearance:none;width:100%;height:3px;
    background:var(--line-old);border-radius:2px;outline:none;cursor:pointer;
  }
  .grid-leverage-slider::-webkit-slider-thumb{
    -webkit-appearance:none;appearance:none;width:16px;height:16px;border-radius:50%;
    background:var(--teal);cursor:pointer;border:2px solid var(--bg);
    box-shadow:0 0 0 2px var(--teal);
  }
  .grid-leverage-slider::-moz-range-thumb{
    width:16px;height:16px;border-radius:50%;background:var(--teal);cursor:pointer;
    border:2px solid var(--bg);box-shadow:0 0 0 2px var(--teal);
  }
  .grid-leverage-ticks{
    display:flex;justify-content:space-between;
    font-size:9px;color:var(--text-faint);margin-top:3px;
  }
  .grid-capital-check{
    border-radius:6px;padding:7px 11px;font-size:11px;line-height:1.4;margin-bottom:10px;
  }
  .grid-capital-check.ok{background:var(--green-dim);color:var(--green);border:1px solid rgba(61,220,151,0.25);}
  .grid-capital-check.warn{background:var(--red-dim);color:var(--red);border:1px solid rgba(226,100,95,0.25);}
  .grid-controls{display:flex;gap:8px;flex-wrap:wrap;}
  .grid-btn{
    flex:1;padding:10px 14px;border:none;border-radius:10px;font-size:12px;
    font-weight:600;cursor:pointer;font-family:var(--font);
    display:flex;align-items:center;justify-content:center;gap:6px;transition:opacity 0.15s;
  }
  .grid-btn:disabled{opacity:0.4;cursor:not-allowed;}
  .grid-btn-start{background:var(--teal);color:#07060c;}
  .grid-btn-start:hover:not(:disabled){opacity:0.88;}
  .grid-btn-pause{background:var(--amber-dim);color:var(--amber);border:1px solid rgba(217,169,63,0.3);}
  .grid-btn-pause:hover:not(:disabled){opacity:0.8;}
  .grid-btn-stop{background:var(--red-dim);color:var(--red);border:1px solid rgba(226,100,95,0.3);}
  .grid-btn-stop:hover:not(:disabled){opacity:0.8;}
  .grid-live-dot{width:7px;height:7px;border-radius:50%;background:var(--text-faint);}
  .grid-live-dot.live{background:var(--green);}
  .grid-live-dot.paused{background:var(--amber);}
  .grid-live-dot.error{background:var(--red);}
  .grid-stats-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;}
  .grid-stat{background:rgba(255,255,255,0.03);border-radius:8px;padding:10px 12px;}
  .grid-stat-label{font-size:10px;color:var(--text-faint);margin-bottom:4px;letter-spacing:0.2px;}
  .grid-stat-val{font-size:16px;font-weight:600;color:var(--text);}
  .grid-stat-val.up{color:var(--green);}
  .grid-stat-val.down{color:var(--red);}
  .grid-viz-wrap{position:relative;min-height:300px;}
  .grid-viz-empty{
    position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    font-size:12px;color:var(--text-faint);text-align:center;padding:20px;
  }
  .grid-viz-legend{display:flex;gap:12px;font-size:10px;font-weight:600;letter-spacing:0.3px;}
  .legend-buy{color:var(--green);}
  .legend-sell{color:var(--red);}
  .legend-price{color:var(--amber);}
  .grid-level-table-wrap{max-height:300px;overflow-y:auto;}
  .grid-level-table{width:100%;border-collapse:collapse;font-size:12px;}
  .grid-level-table th{
    text-align:left;padding:7px 10px;font-size:10px;font-weight:600;
    color:var(--text-faint);letter-spacing:0.3px;border-bottom:1px solid var(--line-old);
    position:sticky;top:0;background:var(--card);
  }
  .grid-level-table td{padding:7px 10px;border-bottom:0.5px solid var(--line-old);color:var(--text);}
  .grid-level-table tr:last-child td{border-bottom:none;}
  .grid-table-empty{text-align:center;color:var(--text-faint);padding:24px!important;}
  .gl-side-buy{color:var(--green);font-weight:600;}
  .gl-side-sell{color:var(--red);font-weight:600;}
  .gl-status-open{color:var(--teal);}
  .gl-status-filled{color:var(--amber);}
  .gl-status-idle{color:var(--text-faint);}
  .gl-status-sl{color:var(--red);}
  /* ---- grid bot docs accordion ---- */
  .grid-docs{
    margin-top:18px;
    border:0.5px solid var(--line-old);
    border-radius:var(--radius-card);
    background:var(--card);
    overflow:hidden;
  }
  .grid-docs-trigger{
    display:flex;align-items:center;justify-content:space-between;
    padding:16px 20px;cursor:pointer;user-select:none;
    gap:10px;
  }
  .grid-docs-trigger:hover{background:rgba(255,255,255,0.025);}
  .grid-docs-trigger-left{display:flex;align-items:center;gap:10px;}
  .grid-docs-trigger-left i{font-size:16px;color:var(--teal);flex-shrink:0;}
  .grid-docs-title{font-size:13px;font-weight:600;color:var(--text);}
  .grid-docs-chevron{
    font-size:16px;color:var(--text-faint);flex-shrink:0;
    transition:transform 0.22s ease;
  }
  .grid-docs.open .grid-docs-chevron{transform:rotate(180deg);}
  .grid-docs-body{
    display:none;
    padding:0 24px 24px;
    border-top:0.5px solid var(--line-old);
  }
  .grid-docs.open .grid-docs-body{display:block;}
  .grid-docs-body h3{
    font-size:11px;font-weight:700;color:var(--teal);
    text-transform:uppercase;letter-spacing:0.5px;
    margin:22px 0 8px;
  }
  .grid-docs-body h3:first-child{margin-top:20px;}
  .grid-docs-body p{
    font-size:12px;color:var(--text-dim);line-height:1.65;margin:0 0 10px;
  }
  .grid-docs-body ul{
    margin:0 0 10px;padding-left:18px;
  }
  .grid-docs-body ul li{
    font-size:12px;color:var(--text-dim);line-height:1.65;margin-bottom:4px;
  }
  .grid-docs-body ul li strong,.grid-docs-body p strong{color:var(--text);}
  .grid-docs-table{
    width:100%;border-collapse:collapse;margin-bottom:10px;font-size:12px;
  }
  .grid-docs-table th{
    text-align:left;padding:7px 10px;font-size:10px;font-weight:600;
    color:var(--text-faint);letter-spacing:0.3px;
    border-bottom:1px solid var(--line-old);
  }
  .grid-docs-table td{
    padding:8px 10px;border-bottom:0.5px solid var(--line-old);
    color:var(--text-dim);vertical-align:top;line-height:1.5;
  }
  .grid-docs-table td:first-child{color:var(--text);font-weight:500;white-space:nowrap;}
  .grid-docs-table tr:last-child td{border-bottom:none;}
  .grid-docs-formula{
    background:rgba(255,255,255,0.04);border:0.5px solid var(--line-old);
    border-radius:8px;padding:10px 14px;font-size:12px;
    color:var(--teal);font-family:monospace;margin:8px 0 12px;
    letter-spacing:0.2px;
  }
  .grid-docs-note{
    background:var(--amber-dim);border:0.5px solid rgba(217,169,63,0.25);
    border-radius:8px;padding:10px 14px;font-size:11px;color:var(--amber);
    line-height:1.6;margin-top:16px;
  }

  /* grid toast */
  .grid-toast{
    position:fixed;bottom:24px;right:24px;z-index:9999;
    background:var(--card);border:1px solid var(--line-old);border-radius:10px;
    padding:11px 18px;font-size:13px;color:var(--text);
    box-shadow:0 4px 24px rgba(0,0,0,0.5);
    transform:translateY(20px);opacity:0;pointer-events:none;
    transition:all 0.22s ease;max-width:360px;
  }
  .grid-toast.show{transform:translateY(0);opacity:1;}

  /* ===== DASHBOARD BALANCE CARDS ===== */
  .balance-grid{display:grid;grid-template-columns:1.8fr 1fr 1fr;gap:12px;margin-bottom:18px;}
  .total-card{
    background:var(--card);border-radius:var(--radius-card);padding:22px 24px;
    border:0.5px solid var(--line-old);position:relative;overflow:hidden;
  }
  .total-card::before{
    content:'';position:absolute;inset:0;border-radius:var(--radius-card);
    border:1px solid rgba(40,215,200,0.15);pointer-events:none;
  }
  .total-label{font-size:11px;color:var(--text-dim);letter-spacing:0.3px;margin-bottom:8px;}
  .total-amount{font-size:36px;font-weight:700;color:var(--text);letter-spacing:-1px;line-height:1;}
  .total-sub{font-size:11px;color:var(--text-faint);margin-top:8px;}
  .total-change{
    display:inline-flex;align-items:center;gap:4px;font-size:12px;
    color:var(--green);margin-top:10px;background:rgba(61,220,151,0.1);
    padding:3px 10px;border-radius:var(--radius-pill);
  }
  .exchange-card{
    background:var(--card);border-radius:var(--radius-card);padding:18px;
    border:0.5px solid var(--line-old);
  }
  .ex-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
  .ex-name{font-size:11px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.4px;}
  .ex-dot{width:6px;height:6px;border-radius:50%;background:var(--green);}
  .ex-amount{font-size:22px;font-weight:600;color:var(--text);letter-spacing:-0.5px;}
  .ex-sub{font-size:11px;color:var(--text-faint);margin-top:4px;}
  .ex-bar{height:2px;background:var(--line-old);border-radius:2px;margin-top:14px;}
  .ex-bar-fill{height:2px;border-radius:2px;background:var(--teal);}
  /* blur-toggle for balance privacy */
  .balances-hidden .total-amount,
  .balances-hidden .ex-amount{filter:blur(7px);user-select:none;pointer-events:none;}
  .hide-balance-btn{
    display:flex;align-items:center;gap:6px;background:rgba(255,255,255,0.04);
    border:0.5px solid var(--line-old);border-radius:var(--radius-pill);
    padding:5px 13px;cursor:pointer;color:var(--text-dim);font-size:11px;
    margin-bottom:16px;font-family:var(--font);
  }
  .hide-balance-btn:hover{color:var(--text);border-color:var(--teal);}
  .hide-balance-btn i{font-size:14px;}

  /* potential trades section header */
  .section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}
  .section-title{font-size:13px;font-weight:600;color:var(--text);}
  .section-sub{font-size:11px;color:var(--text-faint);}
  .potential-row{
    display:flex;align-items:center;justify-content:space-between;
    padding:10px 0;border-bottom:0.5px solid var(--line-old);cursor:pointer;
  }
  .potential-row:last-child{border-bottom:none;}
  .potential-row:hover .pr-sym{color:var(--teal);}
  .pr-left{display:flex;align-items:center;gap:10px;}
  .pr-right{display:flex;align-items:center;gap:14px;}
  .pr-sym{font-weight:600;color:var(--text);font-size:13px;transition:color 0.1s;}
  .pr-mkt{font-size:9px;color:var(--text-faint);margin-left:5px;text-transform:uppercase;}

  /* ===== TRADE TAB — EXECUTOR + CHECKLIST ===== */
  .jf-checks{
    border:1px solid var(--line);border-radius:var(--radius-card);padding:14px 16px;
    background:rgba(255,255,255,0.012);
  }
  .jf-checks-title{font-size:10px;color:var(--dim);letter-spacing:0.5px;margin-bottom:10px;font-weight:600;}
  .jf-check{
    display:flex;align-items:center;gap:7px;font-size:12px;color:var(--text);
    padding:5px 0;cursor:pointer;
  }
  .jf-check input{cursor:pointer;accent-color:var(--teal);}
  .jf-check-note{font-size:10px;color:var(--dim);margin-top:6px;font-style:italic;}

  .trade-layout{display:grid;grid-template-columns:1.2fr 1fr;gap:14px;align-items:start;}
  @media(max-width:760px){.trade-layout{grid-template-columns:1fr;}}

  .jf-executor{
    border:1px solid var(--line);border-radius:var(--radius-card);padding:16px;
    background:rgba(155,138,232,0.03);display:flex;flex-direction:column;gap:10px;
  }
  .jf-executor-title{
    font-size:10px;color:var(--violet);letter-spacing:0.5px;
    display:flex;align-items:center;justify-content:space-between;
  }
  .jf-executor-title .exec-status{
    font-size:9px;font-weight:700;padding:2px 7px;border-radius:3px;letter-spacing:0.3px;
  }
  .exec-status.armed{background:var(--teal-dim);color:var(--teal);border:1px solid rgba(40,215,200,0.4);}
  .exec-status.off{background:rgba(255,255,255,0.04);color:var(--dim);border:1px solid var(--line);}

  .exec-ticker-row{display:flex;gap:8px;align-items:flex-end;}
  .exec-ticker-row input{
    flex:1;background:var(--bg);border:1px solid var(--line);color:var(--text);
    font-family:var(--font);font-size:13px;padding:8px 10px;border-radius:6px;
  }
  .exec-ticker-row input:focus{outline:none;border-color:var(--teal);}

  .exec-dir-toggle{display:flex;gap:0;border:1px solid var(--line);border-radius:6px;overflow:hidden;}
  .exec-dir-toggle button{
    flex:1;background:none;border:none;color:var(--dim);font-family:var(--font);
    font-size:11px;padding:7px 0;cursor:pointer;font-weight:500;letter-spacing:0.3px;
  }
  .exec-dir-toggle button.active-long{background:var(--teal-dim);color:var(--teal);font-weight:700;}
  .exec-dir-toggle button.active-short{background:var(--red-dim);color:var(--red);font-weight:700;}
  .exec-dir-toggle button:not(:last-child){border-right:1px solid var(--line);}

  .exec-order-type-toggle{display:flex;gap:0;border:1px solid var(--line);border-radius:6px;overflow:hidden;}
  .exec-order-type-toggle button{
    flex:1;background:none;border:none;color:var(--dim);font-family:var(--font);
    font-size:10.5px;padding:6px 0;cursor:pointer;letter-spacing:0.3px;
  }
  .exec-order-type-toggle button.active{background:var(--violet-dim);color:var(--violet);font-weight:700;}
  .exec-order-type-toggle button:not(:last-child){border-right:1px solid var(--line);}

  .exec-field-row{display:flex;gap:8px;}
  .exec-field-row label{
    display:flex;flex-direction:column;gap:4px;font-size:10px;color:var(--dim);
    letter-spacing:0.2px;flex:1;min-width:0;
  }
  .exec-field-row input{
    background:var(--bg);border:1px solid var(--line);color:var(--text);
    font-family:var(--font);font-size:12px;padding:7px 9px;border-radius:6px;width:100%;
  }
  .exec-field-row input:disabled{opacity:0.4;cursor:not-allowed;}
  .exec-field-row input:focus{outline:none;border-color:var(--violet);}

  .exec-sl-line{
    display:flex;align-items:center;gap:6px;font-size:10px;color:var(--dim);
    padding:8px 0 2px;border-top:1px solid var(--line);
  }
  .exec-sl-line b{color:var(--text);font-weight:600;}
  .sl-badge{
    font-size:9px;font-weight:700;padding:1px 6px;border-radius:3px;
    background:var(--red-dim);color:var(--red);border:1px solid rgba(255,93,93,0.3);
  }

  .exec-slippage-row{
    display:flex;align-items:center;gap:8px;font-size:10px;color:var(--dim);
  }
  .exec-slippage-row label{display:flex;align-items:center;gap:6px;flex:1;}
  .exec-slippage-row input{
    width:54px;background:var(--bg);border:1px solid var(--line);color:var(--text);
    font-family:var(--font);font-size:11px;padding:5px 7px;border-radius:4px;text-align:right;
  }
  .exec-slippage-row input:focus{outline:none;border-color:var(--violet);}
  .exec-slippage-note{font-size:9px;color:var(--dim);font-style:italic;}

  .exec-validation-msg{
    font-size:10px;color:var(--amber);padding:6px 8px;
    background:rgba(217,169,63,0.08);border:1px solid rgba(217,169,63,0.25);border-radius:4px;
  }
  .exec-place-btn{
    background:none;border:1px solid var(--violet);color:var(--violet);
    font-family:var(--font);font-size:12px;padding:10px;border-radius:8px;
    cursor:pointer;font-weight:600;letter-spacing:0.3px;width:100%;
  }
  .exec-place-btn:hover{background:var(--violet-dim);}
  .exec-place-btn:disabled{opacity:0.4;cursor:default;}
  .exec-submit-note{font-size:9.5px;color:var(--dim);font-style:italic;text-align:center;}

  .size-pill{
    background:rgba(255,255,255,0.05);border:1px solid var(--line);color:var(--dim);
    font-family:var(--font);font-size:10px;padding:3px 9px;border-radius:20px;
    cursor:pointer;font-weight:500;
  }
  .size-pill:hover{border-color:var(--teal);color:var(--teal);background:var(--teal-dim);}
  .size-pill.active{border-color:var(--teal);color:var(--teal);background:var(--teal-dim);font-weight:600;}

  .exec-modal-overlay{
    position:fixed;top:0;left:0;width:100%;height:100%;
    background:rgba(0,0,0,0.6);z-index:1000;
    display:flex;align-items:center;justify-content:center;
  }
  .exec-modal-card{
    background:var(--bg);border:1px solid var(--red);border-radius:10px;
    padding:20px 22px;max-width:380px;width:90%;
  }
  .exec-modal-title{font-size:13px;font-weight:700;color:var(--red);margin-bottom:10px;}
  .exec-modal-body{font-size:12px;color:var(--text-dim);line-height:1.5;margin-bottom:16px;}
  .exec-modal-dismiss{
    background:none;border:1px solid var(--red);color:var(--red);
    border-radius:4px;padding:6px 14px;font-size:11px;cursor:pointer;
    font-family:var(--font);float:right;
  }
  .exec-modal-dismiss:hover{background:var(--red-dim);}

  .trade-autofill-note{
    font-size:10px;color:var(--teal);margin-bottom:6px;font-style:italic;
  }

  /* ===================== PORTED WATCHLIST/MODAL/ALERTS CSS =====================
     Brought across verbatim from the old single-file app. Uses legacy --panel/
     --line/--dim/--mono tokens, aliased above to the new Selimor palette so colors
     update automatically without needing every rule rewritten by hand. */
  #refreshBtn, .refresh-btn{
    background:none;border:1px solid var(--line);color:var(--text);
    font-family:var(--mono);font-size:11px;padding:6px 12px;border-radius:3px;
    cursor:pointer;
  }
  #refreshBtn:hover, .refresh-btn:hover{border-color:var(--green);color:var(--green);}
  #refreshBtn:disabled, .refresh-btn:disabled{opacity:0.4;cursor:default;}
  /* override the #refreshBtn ID rule when it's used as a small inline button —
     ID specificity would otherwise win over .refresh-btn-small regardless of order */
  #refreshBtn.refresh-btn-small{
    font-size:9px;padding:3px 8px;color:var(--dim);border-color:var(--line);
  }

  .toolbar{display:flex;align-items:center;gap:14px;margin-bottom:16px;flex-wrap:wrap;}

  .tabs{display:flex;gap:6px;}
  .tab{
    background:none;border:1px solid var(--line);color:var(--dim);
    font-family:var(--mono);font-size:11px;padding:6px 14px;border-radius:3px;
    cursor:pointer;letter-spacing:0.5px;
  }
  .tab.active{color:var(--bg);background:var(--green);border-color:var(--green);font-weight:700;}

  /* refresh button sits inside the tabs row but is intentionally smaller and
     visually quieter than CRYPTO/STOCKS — it's a utility action, not a primary
     filter, so it shouldn't compete for attention with the market switcher */
  .refresh-btn-small{
    background:none;border:1px solid var(--line);color:var(--dim);
    font-family:var(--mono);font-size:9px;padding:4px 9px;border-radius:3px;
    cursor:pointer;letter-spacing:0.3px;margin-left:4px;
  }
  .refresh-btn-small:hover{border-color:var(--green);color:var(--green);}
  .refresh-btn-small:disabled{opacity:0.4;cursor:default;}

  /* compact stats strip - this used to be three large boxes, which gave irrelevant
     glance-once numbers far more visual weight than they deserved. Now it's a single
     small inline line, de-emphasized, sitting next to the tabs/refresh button instead
     of taking up its own full-width row. */
  .stats-strip{
    font-size:11px;color:var(--dim);letter-spacing:0.3px;margin-left:auto;
  }
  .stats-strip span{color:var(--green);font-weight:700;}

  table{width:100%;max-width:720px;border-collapse:collapse;font-size:13px;}
  thead th{
    text-align:left;font-size:10px;color:var(--dim);letter-spacing:0.6px;
    padding:6px 14px 6px 10px;border-bottom:1px solid var(--line);cursor:pointer;
    user-select:none;white-space:nowrap;
  }
  thead th:hover{color:var(--text);}
  thead th.sorted{color:var(--green);}
  th.col-symbol, td.sym{width:auto;}
  th.col-dist, td.num{width:1%;}
  th.col-rvol, td.rvol-cell{width:1%;}
  th.col-score, td.score-cell{width:1%;}
  th.col-funding, td.funding-cell{width:1%;}
  th.col-swept, td.swept-cell{width:1%;}
  tbody tr{border-bottom:1px solid var(--line);position:relative;}
  tbody tr:hover{background:#0f1419;}

  /* visual triage: a stronger row-level treatment for Excellent/Excellent+ setups so
     they're visible while scanning the list, not just from the badge text. A left-edge
     accent bar plus a faint background wash, with excellent_plus slightly stronger than
     plain excellent. Kept subtle on purpose - not a flashing alert, just a nudge. */
  tbody tr.row-highlight-excellent{
    background:rgba(45,212,160,0.045);
    box-shadow:inset 3px 0 0 0 rgba(45,212,160,0.5);
  }
  tbody tr.row-highlight-excellent:hover{background:rgba(45,212,160,0.08);}
  tbody tr.row-highlight-excellent_plus{
    background:rgba(45,212,160,0.08);
    box-shadow:inset 3px 0 0 0 var(--green);
  }
  tbody tr.row-highlight-excellent_plus:hover{background:rgba(45,212,160,0.13);}
  td{padding:9px 14px 9px 10px;white-space:nowrap;}
  td.sym{font-weight:700;}
  td.num{text-align:right;font-variant-numeric:tabular-nums;}
  th.col-dist{text-align:right;}
  th.col-rvol{text-align:right;}
  td.score-cell{text-align:center;}
  td.funding-cell{text-align:center;}
  td.swept-cell{text-align:center;}
  .pct{font-weight:700;}
  .pct.pos{color:var(--green);}
  .pct.neg{color:var(--red);}

  .rvol-badge{
    font-size:10px;color:var(--dim);font-weight:600;
  }
  .rvol-badge.hot{color:var(--amber);font-weight:700;}

  .score-badge{
    font-size:9px;font-weight:700;padding:3px 8px;border-radius:3px;letter-spacing:0.4px;
    display:inline-block;
  }
  .score-badge.bad{background:var(--red-dim);color:var(--red);}
  .score-badge.good{background:rgba(240,180,41,0.12);color:var(--amber);border:1px solid rgba(240,180,41,0.3);}
  .score-badge.excellent{background:var(--green-dim);color:var(--green);border:1px solid rgba(45,212,160,0.4);}
  .score-badge.excellent_plus{
    background:var(--green-dim);color:var(--green);border:1px solid var(--green);
    box-shadow:0 0 8px rgba(45,212,160,0.35);
  }

  .swept-tfs{
    font-size:10px;font-weight:700;color:var(--violet);letter-spacing:0.3px;
  }
  .swept-tfs.none{color:var(--dim);font-weight:400;}
  /* with the tightened per-timeframe freshness windows (max 3 bars on 4H, 1 on 12H/3D),
     anything that still qualifies for a score is inherently fresh - .aging is unused
     now but left defined in case freshness windows are loosened again later */
  .swept-tfs.fresh{opacity:1;}
  .swept-tfs.aging{opacity:0.55;}
  .swept-ago{
    font-size:9px;color:var(--dim);margin-left:5px;font-weight:400;
  }

  /* tiny dot next to DIST% showing how far price has extended from the 4H 200EMA -
     deliberately subtle since this is supporting context, not a primary signal */
  .dist-tier-dot{
    display:inline-block;width:5px;height:5px;border-radius:50%;
    margin-left:5px;vertical-align:middle;cursor:help;
  }
  .dist-tier-dot.tight{background:var(--dim);opacity:0.5;}
  .dist-tier-dot.extended{background:var(--amber);opacity:0.6;}
  .dist-tier-dot.very_extended{background:var(--red);opacity:0.7;}

  /* flags rows where the 4H 200EMA hasn't matured yet (fewer than 200 real 4H
     candles available) - mainly relevant for newly-listed RWA stock markets on
     Lighter, where DIST% and score can be wildly misleading until enough history
     exists. Sits right next to the symbol so it's seen before the (possibly bogus)
     numbers further down the row. */
  .immature-badge{
    font-size:8px;font-weight:700;color:var(--amber);border:1px solid rgba(240,180,41,0.4);
    border-radius:3px;padding:1px 4px;margin-left:6px;letter-spacing:0.3px;cursor:help;
    vertical-align:middle;
  }

  /* funding rate now has its own column (FUNDING) rather than sitting inline next
     to the score badge - OI delta stays tucked into the dot's tooltip alongside it */
  .funding-text{
    font-size:10px;font-weight:600;letter-spacing:0.2px;
  }
  .funding-text.neg{color:var(--green);opacity:0.85;}
  .funding-text.pos{color:var(--red);opacity:0.85;}
  .funding-text.flat{color:var(--dim);}

  /* small funding-rate/OI confluence indicator next to the funding text -
     intentionally quiet (a small dot, not its own column) since OI wasn't asked
     to be made visible inline, just funding rate itself */
  .conf-dot{
    display:inline-block;width:6px;height:6px;border-radius:50%;
    margin-left:4px;vertical-align:middle;cursor:help;
  }
  .conf-dot.neg{background:var(--green);opacity:0.55;}
  .conf-dot.pos{background:var(--red);opacity:0.55;}
  .conf-dot.flat{background:var(--dim);opacity:0.4;}

  .strip{
    display:inline-block;width:38px;height:8px;border-radius:2px;margin-right:8px;
    vertical-align:middle;
  }
  .strip.above{background:var(--green);box-shadow:0 0 6px rgba(45,212,160,0.5);}
  .strip.below{background:var(--red);box-shadow:0 0 6px rgba(255,93,93,0.4);}

  .tv-link{
    font-size:9px;color:var(--dim);margin-left:8px;text-decoration:none;
    border:1px solid var(--line);border-radius:3px;padding:1px 4px;vertical-align:middle;
    font-weight:400;
  }
  .tv-link:hover{color:var(--green);border-color:var(--green);}

  tbody tr.clickable{cursor:pointer;}
  tbody tr.clickable:hover td.sym{color:var(--green);}

  .loading,.err{padding:40px;text-align:center;color:var(--dim);font-size:12px;}
  .err{color:var(--red);}

  footer{margin-top:24px;font-size:10px;color:var(--dim);line-height:1.6;}

  .modal-bg{
    position:fixed;inset:0;background:rgba(0,0,0,0.7);
    display:none;align-items:center;justify-content:center;z-index:50;padding:16px;
  }
  .modal-bg.open{display:flex;}
  .modal{
    background:var(--panel);border:1px solid var(--line);border-radius:6px;
    width:100%;max-width:760px;padding:18px;position:relative;
  }
  .modal-close{
    position:absolute;top:12px;right:14px;background:none;border:none;color:var(--dim);
    font-size:18px;cursor:pointer;line-height:1;
  }
  .modal-close:hover{color:var(--text);}
  .modal-head{display:flex;align-items:baseline;gap:12px;margin-bottom:4px;flex-wrap:wrap;}
  .modal-head .sym{font-size:18px;font-weight:700;}
  .modal-head .dist{font-size:12px;font-weight:700;}
  .modal-sub{font-size:11px;color:var(--dim);margin-bottom:10px;}
  .tf-row{display:flex;gap:6px;margin-bottom:14px;}
  .tf-btn{
    background:none;border:1px solid var(--line);color:var(--dim);
    font-family:var(--mono);font-size:11px;padding:5px 12px;border-radius:3px;
    cursor:pointer;letter-spacing:0.4px;
  }
  .tf-btn.active{color:var(--bg);background:var(--amber);border-color:var(--amber);font-weight:700;}
  .tf-btn:disabled{opacity:0.4;cursor:default;}
  .legend{display:flex;gap:16px;font-size:10px;color:var(--dim);margin-top:8px;}
  .legend .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:middle;}
  .legend .dot.up{background:var(--green);}
  .legend .dot.down{background:var(--red);}
  .legend .dot.ema{background:var(--amber);border-radius:0;width:12px;height:2px;}
  .legend .dot.ema4h{background:var(--violet);border-radius:0;width:12px;height:2px;}
  .legend .dot.resting{background:var(--dim);border-radius:0;width:10px;height:2px;}
  .legend .dot.swept{background:#5aa9e6;border-radius:0;width:10px;height:2px;}
  .legend .dot.reclaimed{background:#f4f4f4;border-radius:0;width:10px;height:2px;}
  #chartCanvas{width:100%;display:block;background:#0a0d0f;border-radius:4px;}
  .chart-loading{padding:60px;text-align:center;color:var(--dim);font-size:12px;}

  /* alerts panel */
  .alert-panel{
    background:var(--panel);border:1px solid var(--line);border-radius:4px;
    padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;
    justify-content:space-between;flex-wrap:wrap;gap:10px;
  }
  .alert-info{font-size:11px;color:var(--dim);line-height:1.5;}
  .alert-info b{color:var(--text);}
  .alert-status{font-size:10px;font-weight:700;padding:3px 9px;border-radius:3px;letter-spacing:0.4px;}
  .alert-status.on{background:var(--green-dim);color:var(--green);}
  .alert-status.off{background:var(--red-dim);color:var(--red);}
  #alertToggleBtn, .alert-btn{
    background:none;border:1px solid var(--line);color:var(--text);
    font-family:var(--mono);font-size:11px;padding:6px 12px;border-radius:3px;cursor:pointer;
  }
  #alertToggleBtn:hover, .alert-btn:hover{border-color:var(--violet);color:var(--violet);}
  .alert-status.warn{background:rgba(240,180,41,0.12);color:var(--amber);}
  .alert-log{font-size:10px;color:var(--dim);margin-top:8px;max-height:160px;overflow-y:auto;border-top:1px solid var(--line);padding-top:6px;}
  .alert-log div{padding:2px 0;}
  .alert-log .hit{color:var(--violet);}
  .alert-log-empty{color:var(--dim);font-style:italic;}
  #clearLogBtn{
    background:none;border:1px solid var(--line);color:var(--dim);
    font-family:var(--mono);font-size:10px;padding:4px 9px;border-radius:3px;cursor:pointer;
  }
  #clearLogBtn:hover{border-color:var(--red);color:var(--red);}

  /* ===================== JOURNAL TAB ===================== */
  .journal-stats-row{
    display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px;
  }
  .jstat-card{
    background:var(--card);border-radius:var(--radius-card);padding:14px 16px;
    border:0.5px solid var(--line-old);
  }
  .jstat-label{font-size:10px;color:var(--text-faint);letter-spacing:0.3px;margin-bottom:6px;}
  .jstat-value{font-size:22px;font-weight:700;color:var(--text);letter-spacing:-0.5px;}
  .jstat-value.win{color:var(--green);}
  .jstat-value.loss{color:var(--red);}
  .jstat-sub{font-size:10px;color:var(--text-faint);margin-top:4px;}

  /* manual entry form */
  .journal-form-card{
    background:var(--card);border-radius:var(--radius-card);padding:16px;
    border:0.5px solid var(--line-old);margin-bottom:16px;
  }
  .journal-form-header{
    display:flex;align-items:center;justify-content:space-between;
    cursor:pointer;user-select:none;margin-bottom:0;
  }
  .journal-form-header.open{margin-bottom:16px;}
  .journal-form-title{font-size:12px;font-weight:600;color:var(--text-dim);letter-spacing:0.3px;}
  .journal-form-toggle{
    font-size:10px;color:var(--teal);border:1px solid rgba(40,215,200,0.3);
    border-radius:var(--radius-pill);padding:3px 10px;cursor:pointer;
    background:none;font-family:var(--font);
  }
  .journal-form-toggle:hover{background:var(--teal-dim);}
  .journal-form-body{display:none;}
  .journal-form-body.open{display:block;}

  .jf-row{display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap;}
  .jf-field{display:flex;flex-direction:column;gap:4px;font-size:10px;color:var(--text-faint);flex:1;min-width:100px;}
  .jf-field input,.jf-field select{
    background:var(--bg);border:1px solid var(--line-old);color:var(--text);
    font-family:var(--font);font-size:12px;padding:7px 9px;border-radius:6px;width:100%;
  }
  .jf-field input:focus,.jf-field select:focus{outline:none;border-color:var(--teal);}

  .jf-checks-inline{
    display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;
  }
  .jf-check-pill{
    display:flex;align-items:center;gap:5px;font-size:10px;color:var(--text-dim);
    background:rgba(255,255,255,0.03);border:1px solid var(--line-old);
    border-radius:var(--radius-pill);padding:4px 10px;cursor:pointer;
  }
  .jf-check-pill input{cursor:pointer;accent-color:var(--teal);}
  .jf-check-pill:has(input:checked){border-color:var(--teal);color:var(--teal);background:var(--teal-dim);}

  .journal-form-actions{display:flex;gap:8px;margin-top:4px;}
  .jf-submit-btn{
    background:none;border:1px solid var(--teal);color:var(--teal);
    font-family:var(--font);font-size:11px;padding:8px 18px;border-radius:6px;
    cursor:pointer;font-weight:600;
  }
  .jf-submit-btn:hover{background:var(--teal-dim);}
  .jf-cancel-btn{
    background:none;border:1px solid var(--line-old);color:var(--text-dim);
    font-family:var(--font);font-size:11px;padding:8px 14px;border-radius:6px;cursor:pointer;
  }
  .jf-cancel-btn:hover{border-color:var(--red);color:var(--red);}

  /* trade log table */
  .journal-log-card{
    background:var(--card);border-radius:var(--radius-card);padding:16px;
    border:0.5px solid var(--line-old);
  }
  .journal-log-header{
    display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px;
  }
  .journal-log-title{font-size:12px;font-weight:600;color:var(--text-dim);letter-spacing:0.3px;}
  .journal-export-row{display:flex;gap:6px;}
  .journal-export-btn{
    background:none;border:1px solid var(--line-old);color:var(--text-faint);
    font-family:var(--font);font-size:10px;padding:4px 10px;border-radius:var(--radius-pill);
    cursor:pointer;display:flex;align-items:center;gap:4px;
  }
  .journal-export-btn:hover{border-color:var(--teal);color:var(--teal);}
  .journal-export-btn i{font-size:12px;}

  .journal-table{width:100%;border-collapse:collapse;font-size:11px;}
  .journal-table thead th{
    text-align:left;font-size:9px;color:var(--text-faint);letter-spacing:0.5px;
    padding:5px 8px;border-bottom:1px solid var(--line-old);white-space:nowrap;
    user-select:none;
  }
  .journal-table tbody tr{border-bottom:0.5px solid var(--line-old);}
  .journal-table tbody tr:hover{background:rgba(255,255,255,0.025);}
  .journal-table tbody tr:last-child{border-bottom:none;}
  .journal-table td{padding:8px 8px;white-space:nowrap;color:var(--text);}

  .jt-dir-long{font-size:9px;font-weight:700;color:var(--teal);background:var(--teal-dim);
    border-radius:3px;padding:2px 6px;letter-spacing:0.3px;}
  .jt-dir-short{font-size:9px;font-weight:700;color:var(--red);background:var(--red-dim);
    border-radius:3px;padding:2px 6px;letter-spacing:0.3px;}

  .jt-outcome{font-size:9px;font-weight:700;border-radius:3px;padding:2px 6px;letter-spacing:0.3px;}
  .jt-outcome.open{background:var(--violet-dim);color:var(--violet);}
  .jt-outcome.win{background:var(--green-dim);color:var(--green);}
  .jt-outcome.loss{background:var(--red-dim);color:var(--red);}

  .jt-score{font-size:10px;color:var(--text-dim);font-variant-numeric:tabular-nums;}
  .jt-score.full{color:var(--green);}
  .jt-pct{font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;}
  .jt-pct.pos{color:var(--green);}
  .jt-pct.neg{color:var(--red);}
  .jt-pct.open{color:var(--text-faint);}

  .jt-action-btn{
    background:none;border:none;color:var(--text-faint);cursor:pointer;
    font-size:13px;padding:2px 4px;border-radius:3px;
  }
  .jt-action-btn:hover{color:var(--text);background:rgba(255,255,255,0.06);}
  .jt-action-btn.del:hover{color:var(--red);}

  .journal-empty{
    padding:40px 20px;text-align:center;color:var(--text-faint);font-size:12px;
  }
  .journal-empty i{font-size:28px;display:block;margin-bottom:10px;color:var(--text-faint);}

  /* edit modal */
  .journal-edit-overlay{
    position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:200;
    display:none;align-items:center;justify-content:center;padding:20px;
  }
  .journal-edit-overlay.open{display:flex;}
  .journal-edit-modal{
    background:var(--bg);border:1px solid var(--line-old);border-radius:12px;
    padding:22px 24px;width:100%;max-width:520px;max-height:90vh;overflow-y:auto;
  }
  .journal-edit-title{font-size:13px;font-weight:600;color:var(--text);margin-bottom:16px;
    display:flex;align-items:center;justify-content:space-between;}
  .journal-edit-close{
    background:none;border:none;color:var(--text-dim);font-size:18px;cursor:pointer;line-height:1;
  }
  .journal-edit-close:hover{color:var(--text);}
  .journal-edit-actions{display:flex;gap:8px;margin-top:16px;justify-content:flex-end;}

  /* image attachment */
  .jf-image-upload{
    display:flex;align-items:center;gap:10px;margin-bottom:10px;
  }
  .jf-image-label{
    display:flex;align-items:center;gap:6px;font-size:10px;color:var(--text-faint);
    border:1px dashed var(--line-old);border-radius:6px;padding:7px 12px;cursor:pointer;
    background:rgba(255,255,255,0.02);transition:border-color 0.15s,color 0.15s;
  }
  .jf-image-label:hover{border-color:var(--teal);color:var(--teal);}
  .jf-image-label i{font-size:14px;}
  .jf-image-preview{
    width:48px;height:48px;border-radius:6px;object-fit:cover;
    border:1px solid var(--line-old);cursor:pointer;display:none;
  }
  .jf-image-preview.visible{display:block;}
  .jf-image-remove{
    background:none;border:none;color:var(--text-faint);font-size:12px;cursor:pointer;
    padding:2px 5px;border-radius:3px;display:none;
  }
  .jf-image-remove.visible{display:inline-block;}
  .jf-image-remove:hover{color:var(--red);}

  /* thumbnail in trade log table */
  .jt-thumb{
    width:32px;height:32px;border-radius:4px;object-fit:cover;
    border:1px solid var(--line-old);cursor:pointer;vertical-align:middle;
    transition:transform 0.15s;
  }
  .jt-thumb:hover{transform:scale(1.15);}

  /* full image lightbox */
  .journal-lightbox{
    position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:400;
    display:none;align-items:center;justify-content:center;padding:20px;cursor:zoom-out;
  }
  .journal-lightbox.open{display:flex;}
  .journal-lightbox img{
    max-width:100%;max-height:90vh;border-radius:8px;
    box-shadow:0 8px 40px rgba(0,0,0,0.6);
  }

  /* auto-journal toast */
  .journal-toast{
    position:fixed;bottom:24px;right:24px;z-index:300;
    background:var(--card);border:1px solid var(--teal);border-radius:10px;
    padding:12px 16px;font-size:12px;color:var(--teal);
    display:flex;align-items:center;gap:8px;
    box-shadow:0 4px 20px rgba(40,215,200,0.15);
    transform:translateY(80px);opacity:0;transition:transform 0.25s,opacity 0.25s;
    pointer-events:none;
  }
  .journal-toast.show{transform:translateY(0);opacity:1;}
  .journal-toast i{font-size:16px;}

  /* strategies sub-tabs */

  #bt-log-details summary::-webkit-details-marker{display:none;}
  #bt-log-details summary{list-style:none;}
  #bt-log-details[open] #bt-log-chevron{transform:rotate(90deg);}

</style>
