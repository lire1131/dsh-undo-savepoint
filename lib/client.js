window.__ModuleLoader__.load({
	id: "dsh-undo-savepoint",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// W77（#52）：容错引入 react-dom，只为浮层 portal。loader 模块表里没有它时整段降级，
		// 面板退回原位渲染（受祖先包含块影响的老行为），但客户端整体不崩。
		let reactDom = null;
		try { reactDom = require("react-dom"); } catch (e) { reactDom = null; }
		//#region dsh-undo-savepoint styles
		const css = ".u_actions{display:flex;align-items:center;gap:4px;padding:0 4px}.u_btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip, transparent);color:var(--dsw-alias-label-secondary, inherit);border-radius:8px;height:24px;padding:0 8px;font-size:12px;line-height:20px;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;flex:none;min-width:0}.u_btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary, inherit)}.u_btn:disabled{opacity:.4;cursor:default}.u_undo{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent)}.u_undo:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);color:var(--dsw-alias-state-error-primary)}.u_redo{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent)}.u_redo:hover{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);color:var(--dsw-alias-state-success-primary)}.u_list{color:var(--dsw-alias-label-secondary, inherit)}.u_list:hover{background:var(--dsw-alias-interactive-bg-hover)}.u_msg{max-width:min(280px,40vw);font-size:12px;line-height:18px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;padding:0 8px}.u_ok{color:var(--dsw-alias-label-tertiary)}.u_err{color:var(--dsw-alias-state-error-primary)}.u_overlay{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1);z-index:9999;display:flex;align-items:flex-end;justify-content:center;padding:0 16px 24px}.u_panel{width:min(1180px,96vw);max-height:calc(100vh - 40px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:16px;box-shadow:var(--dsw-elevation-panel);overflow:hidden;animation:u_rise .12s ease-out}@keyframes u_rise{from{transform:translateY(24px);opacity:0}to{transform:translateY(0);opacity:1}}@media (prefers-reduced-motion:reduce){.u_panel{animation:none}}.u_head{display:flex;align-items:center;gap:8px;padding:16px 20px;flex:none}.u_title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary, inherit);flex:1}.u_toolbar{display:flex;align-items:center;gap:8px;padding:12px 16px;flex-wrap:wrap;flex:none}.u_tbody{overflow:auto;padding:8px 16px 12px;flex:1}.u_table{width:100%;border-collapse:collapse;font-size:12px}.u_table th{text-align:left;color:var(--dsw-alias-label-tertiary);font-weight:500;padding:8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}.u_table td{padding:8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle}.u_time{white-space:nowrap;color:var(--dsw-alias-label-secondary, inherit)}.u_kind{white-space:nowrap}.u_reason{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary, inherit)}.u_loc{white-space:nowrap;font-size:12px}.u_rowbtn{cursor:pointer;border:none;background:0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;padding:4px 8px;border-radius:8px}.u_rowbtn:hover{color:var(--dsw-alias-label-primary)}.u_rowbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}.u_rowbtn.u_okc{color:var(--dsw-alias-state-success-primary)}.u_rowbtn.u_errc{color:var(--dsw-alias-state-error-primary)}.u_empty{color:var(--dsw-alias-label-tertiary);text-align:center;padding:24px 0;font-size:13px}.u_foot{display:flex;align-items:center;gap:8px;padding:8px 16px;border-top:1px solid var(--dsw-alias-border-l1);flex:none}.u_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%;padding:8px 16px;box-sizing:border-box}.u_pair{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}.u_keyLabel{color:var(--dsw-alias-label-primary, inherit);font-size:13px;flex:none;min-width:96px}.u_browseBtn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-tip, transparent);color:var(--dsw-alias-label-secondary, inherit);border-radius:6px;width:28px;height:28px;font-size:14px;line-height:1;display:inline-flex;align-items:center;justify-content:center;padding:0}.u_browseBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}.u_keyInput{width:110px;height:28px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base, transparent);color:var(--dsw-alias-label-primary, inherit);border-radius:8px;outline:none;padding:0 8px;font-size:12px;box-sizing:border-box}.u_keyInput:focus{border-color:var(--dsw-alias-state-business-primary)}.u_num{width:84px}.u_dir{width:280px}.u_hint{color:var(--dsw-alias-label-tertiary);font-size:12px;flex:none}.u_save{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-tip, transparent);color:var(--dsw-alias-label-primary, inherit);border-radius:8px;height:24px;padding:0 12px;font-size:12px}.u_save:hover{background:var(--dsw-alias-interactive-bg-hover)}.u_close{cursor:pointer;border:none;background:0 0;color:var(--dsw-alias-label-tertiary);font-size:18px;line-height:1;padding:4px 8px;border-radius:8px}.u_close:hover{background:var(--dsw-alias-interactive-bg-hover)}.u_diffbox{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(720px,92vw);max-height:70vh;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent);z-index:20000;font-size:12px}.u_diffhead{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}.u_diffbody{overflow-y:auto;padding:2px 0 8px;flex:1}.u_difffile{font-weight:600;padding:6px 10px 2px;color:var(--dsw-alias-label-primary, inherit)}.u_diffadd{color:var(--dsw-alias-state-success-primary);padding:0 10px 0 22px;white-space:pre-wrap;word-break:break-all}.u_diffdel{color:var(--dsw-alias-state-error-primary);padding:0 10px 0 22px;white-space:pre-wrap;word-break:break-all}.u_statusBar{display:flex;align-items:center;gap:16px;padding:12px 16px;flex-wrap:wrap;flex:none}.u_stat{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}.u_searchBar{display:flex;align-items:center;gap:8px;padding:12px 16px;flex-wrap:wrap;flex:none}.u_batchBar{display:inline-flex;align-items:center;gap:8px}.u_cards{display:flex;flex-direction:column;gap:8px}.u_group{display:flex;flex-direction:column;gap:8px}.u_groupHead{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;padding:8px 0 0}.u_card{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2);border-radius:0;flex-wrap:wrap}.u_card:hover{background:var(--dsw-alias-bg-layer-2)}.u_card:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.u_cardTime{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}.u_cardReason{color:var(--dsw-alias-label-secondary);font-size:12px;flex:1;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.u_cardOps{display:inline-flex;align-items:center;gap:4px}.u_btn:focus-visible,.u_badge:focus-visible,.u_rowbtn:focus-visible,.u_browseBtn:focus-visible,.u_save:focus-visible,.u_close:focus-visible,.u_list:focus-visible,.u_icon:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.u_state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}.u_stateIcon{font-size:24px;line-height:1}.u_statePrimary{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-tip, transparent);color:var(--dsw-alias-label-primary, inherit);border-radius:8px;height:24px;padding:0 12px;font-size:12px}.u_statePrimary:hover{background:var(--dsw-alias-interactive-bg-hover)}.u_statePrimary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}";
		const tagId = "dsh-undo-savepoint/undo.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-undo-savepoint";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		// v0.3.4 UI 增强补充样式:图标对齐 / 状态徽章 / 面板副标题
		const css2 = ".u_icon{display:inline-block;vertical-align:-2px;flex:none;line-height:0}.u_badge{cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip, transparent);color:var(--dsw-alias-label-secondary, inherit);border-radius:999px;height:20px;padding:0 8px;font-size:11px;line-height:18px;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;flex:none;min-width:0}.u_badge:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary, inherit)}.u_dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none}.u_subtitle{font-size:12px;color:var(--dsw-alias-label-tertiary);font-weight:400;white-space:nowrap;max-width:min(220px,30vw);text-overflow:ellipsis;overflow:hidden}.u_warn{color:var(--dsw-alias-state-warn-primary)}.u_head .u_subtitle{display:none}.u_safe{color:var(--dsw-alias-state-warn-primary);margin-left:auto}.u_stat+.u_stat{padding-left:12px;position:relative}.u_stat+.u_stat::before{content:'·';position:absolute;left:0;color:var(--dsw-alias-label-tertiary)}.u_remoteBar{display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}.u_flow{display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;flex:none}.u_flowStep{font-size:11px;color:var(--dsw-alias-label-tertiary);letter-spacing:.04em}.u_flowName{font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:4px 8px;font-weight:600;max-width:min(260px,40vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.u_flowArrow{color:var(--dsw-alias-label-tertiary);font-size:12px}.u_seg{display:inline-flex;align-items:center;flex-wrap:wrap;max-width:100%;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}.u_segBtn{cursor:pointer;border:none;background:0 0;color:var(--dsw-alias-label-secondary);height:24px;padding:0 16px;font-size:12px;white-space:nowrap}.u_segBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.u_segBtn:disabled{opacity:.5;cursor:default}.u_segOn{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent);color:var(--dsw-alias-label-primary);font-weight:600}.u_storeChip{font-size:12px;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:4px 8px;max-width:min(320px,48vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.u_storeChip.u_warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 50%, transparent)}.u_chipBar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.u_chip{cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:0 0;color:var(--dsw-alias-label-secondary);border-radius:999px;height:24px;padding:0 12px;font-size:12px}.u_chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.u_chipOn{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);font-weight:600}.u_chip:focus-visible,.u_segBtn:focus-visible,.u_profileBadge:focus-visible,.u_diffFileToggle:focus-visible,.u_copyBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.u_stateText{max-width:520px;line-height:20px}.u_profileBadge{display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;height:20px;padding:0 8px;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);white-space:nowrap}.u_profileBadge.u_unknown{color:var(--dsw-alias-label-tertiary);border-style:dashed}.u_profileBadge.u_other{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 50%, transparent)}.u_diffOverlay{position:fixed;inset:0;z-index:20000;display:flex;align-items:center;justify-content:center;padding:16px}.u_diffPanel{width:min(920px,96vw);max-height:80vh;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l3);border-radius:16px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent);overflow:hidden}.u_diffHead{display:flex;align-items:center;gap:8px;padding:16px 20px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}.u_diffTitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.u_diffGroups{overflow:auto;max-height:60vh;padding:8px 0;flex:1}.u_diffGroupHead{display:flex;align-items:center;gap:8px;padding:8px 20px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;background:var(--dsw-alias-bg-layer-2)}.u_diffFile{display:flex;align-items:center;gap:8px;padding:8px 20px;border-top:1px solid var(--dsw-alias-border-l1)}.u_diffFileToggle{cursor:pointer;border:none;background:0 0;color:var(--dsw-alias-label-primary);font-size:12px;padding:4px 8px;border-radius:8px;display:flex;align-items:center;gap:8px;text-align:left;flex:1;min-width:0}.u_diffFileToggle:hover{background:var(--dsw-alias-interactive-bg-hover)}.u_diffPath{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.u_diffAddStat{color:var(--dsw-alias-state-success-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;white-space:nowrap}.u_diffDelStat{color:var(--dsw-alias-state-error-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;white-space:nowrap}.u_diffLines{margin:0;padding:0 0 8px;overflow-x:auto;background:var(--dsw-alias-bg-base)}.u_diffLine{display:block;padding:0 20px 0 40px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:20px;white-space:pre;min-width:max-content}.u_diffLineAdd{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);color:var(--dsw-alias-state-success-primary)}.u_diffLineDel{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);color:var(--dsw-alias-state-error-primary)}.u_diffLineCtx{color:var(--dsw-alias-label-tertiary)}.u_diffNote{padding:8px 20px;color:var(--dsw-alias-label-tertiary);font-size:12px}.u_skel{display:flex;flex-direction:column;gap:8px;padding:16px 20px}.u_skelLine{height:12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}.u_skelLine:nth-child(2){width:80%}.u_skelLine:nth-child(3){width:60%}.u_copyBtn{cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:0 0;color:var(--dsw-alias-label-tertiary);border-radius:8px;height:24px;padding:0 8px;font-size:11px}.u_copyBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.u_meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}.u_metaLabel{color:var(--dsw-alias-label-tertiary)}.u_diffBodyPane{display:flex;min-height:0;max-height:60vh;flex:1}.u_diffNav{width:min(320px,38%);overflow:auto;border-right:1px solid var(--dsw-alias-border-l1);flex:none;padding:8px 0}.u_diffNavGroup{padding:8px 20px 4px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;background:var(--dsw-alias-bg-layer-2)}.u_diffNavFile{cursor:pointer;display:flex;align-items:center;gap:8px;width:100%;border:none;background:0 0;color:var(--dsw-alias-label-primary);font-size:12px;padding:8px 20px;text-align:left}.u_diffNavFile:hover{background:var(--dsw-alias-interactive-bg-hover)}.u_diffNavFile.u_diffNavOn{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);box-shadow:inset 2px 0 0 var(--dsw-alias-state-business-primary)}.u_diffNavFile:focus-visible,.u_diffToggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}.u_diffNavName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.u_diffView{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden}.u_diffViewHead{display:flex;align-items:center;gap:8px;padding:8px 20px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap}.u_diffViewBody{overflow:auto;flex:1}.u_diffToggle{cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:0 0;color:var(--dsw-alias-label-secondary);border-radius:8px;height:24px;padding:0 8px;font-size:11px}.u_diffToggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}@media (max-width:720px){.u_diffBodyPane{flex-direction:column}.u_diffNav{width:auto;max-height:40vh;border-right:none;border-bottom:1px solid var(--dsw-alias-border-l1)}.u_diffViewBody{max-height:44vh}}.u_label{display:inline}.u_badgeTime{display:inline}.u_menuBtn{display:none}.u_menuList{display:flex;flex-direction:column;gap:8px;padding:12px 16px 16px}.u_menuItem{width:100%;justify-content:center}@container (max-width:960px){.u_actions .u_label{display:none}.u_actions .u_badgeTime{display:none}}@container (max-width:640px){.u_actions .u_mid{display:none}.u_actions .u_menuBtn{display:inline-flex}}.u_actions[data-undo-mode=full] .u_label{display:inline}.u_actions[data-undo-mode=full] .u_badgeTime{display:inline}.u_actions[data-undo-mode=full] .u_mid{display:inline-flex}.u_actions[data-undo-mode=full] .u_menuBtn{display:none}.u_actions[data-undo-mode=compact] .u_label{display:none}.u_actions[data-undo-mode=compact] .u_badgeTime{display:none}.u_actions[data-undo-mode=compact] .u_mid{display:none}.u_actions[data-undo-mode=compact] .u_menuBtn{display:inline-flex}";
		const tagId2 = "dsh-undo-savepoint/undo.enhance.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-undo-savepoint";
			tag.dataset.pluginCss = tagId2;
			tag.textContent = css2;
			document.head.appendChild(tag);
		}
		var styles = {
			actions: "u_actions", btn: "u_btn", undo: "u_undo", redo: "u_redo", list: "u_list",
			icon: "u_icon", badge: "u_badge", dot: "u_dot", subtitle: "u_subtitle", warn: "u_warn", remoteBar: "u_remoteBar", safe: "u_safe",
			msg: "u_msg", ok: "u_ok", err: "u_err",
			overlay: "u_overlay", panel: "u_panel", head: "u_head", title: "u_title", toolbar: "u_toolbar",
			tbody: "u_tbody", table: "u_table", time: "u_time", kind: "u_kind", reason: "u_reason", loc: "u_loc",
			rowbtn: "u_rowbtn", okc: "u_okc", errc: "u_errc", empty: "u_empty", foot: "u_foot",
			row: "u_row", pair: "u_pair", keyLabel: "u_keyLabel", keyInput: "u_keyInput", num: "u_num", dir: "u_dir", hint: "u_hint", browseBtn: "u_browseBtn",
			state: "u_state", stateIcon: "u_stateIcon", statePrimary: "u_statePrimary", statusBar: "u_statusBar", stat: "u_stat", searchBar: "u_searchBar", batchBar: "u_batchBar", cards: "u_cards",
			group: "u_group", groupHead: "u_groupHead", card: "u_card", cardTime: "u_cardTime", cardReason: "u_cardReason", cardOps: "u_cardOps",
			save: "u_save", close: "u_close", diffbox: "u_diffbox", diffhead: "u_diffhead", diffbody: "u_diffbody", difffile: "u_difffile", diffadd: "u_diffadd", diffdel: "u_diffdel",
			flow: "u_flow", flowStep: "u_flowStep", flowName: "u_flowName", flowArrow: "u_flowArrow", seg: "u_seg", segBtn: "u_segBtn", segOn: "u_segOn", storeChip: "u_storeChip",
			chipBar: "u_chipBar", chip: "u_chip", chipOn: "u_chipOn", stateText: "u_stateText", profileBadge: "u_profileBadge", profileUnknown: "u_unknown", profileOther: "u_other",
			diffOverlay: "u_diffOverlay", diffPanel: "u_diffPanel", diffTitle: "u_diffTitle", diffGroups: "u_diffGroups", diffGroupHead: "u_diffGroupHead", diffFile: "u_diffFile", diffFileToggle: "u_diffFileToggle", diffPath: "u_diffPath", diffAddStat: "u_diffAddStat", diffDelStat: "u_diffDelStat", diffLines: "u_diffLines", diffLine: "u_diffLine", diffLineAdd: "u_diffLineAdd", diffLineDel: "u_diffLineDel", diffLineCtx: "u_diffLineCtx", diffNote: "u_diffNote", skel: "u_skel", skelLine: "u_skelLine", copyBtn: "u_copyBtn", meta: "u_meta", metaLabel: "u_metaLabel",
			diffBodyPane: "u_diffBodyPane", diffNav: "u_diffNav", diffNavGroup: "u_diffNavGroup", diffNavFile: "u_diffNavFile", diffNavOn: "u_diffNavOn", diffNavName: "u_diffNavName", diffView: "u_diffView", diffViewHead: "u_diffViewHead", diffViewBody: "u_diffViewBody", diffToggle: "u_diffToggle",
			label: "u_label", mid: "u_mid", badgeTime: "u_badgeTime", menuBtn: "u_menuBtn", menuList: "u_menuList", menuItem: "u_menuItem"
		};
		//#endregion
		/**
		 * W77（#52）：浮层 portal 容器。有 react-dom.createPortal 时挂到 document.body，遮罩覆盖
		 * 视口、面板按视口居中，不再受祖先包含块（transform / contain / overflow）影响；取不到
		 * 或调用抛错时原样返回 children，退回原位渲染（不因 portal 失败拖垮整个客户端）。
		 */
		function UndoLayer({ children }) {
			if (reactDom && typeof reactDom.createPortal === "function" && typeof document !== "undefined" && document.body) {
				try { return reactDom.createPortal(children, document.body); } catch (e) { /* 降级为原位渲染 */ }
			}
			return children;
		}

		//#region locales
		const NS = "undo";
		const zh = {
			"undo": "撤销",
			"redo": "重做",
			"snapshots": "快照",
			"undo.aria": "撤销上一步(回退最近一次配置变更)",
			"redo.aria": "重做(应用上一次撤销的内容)",
			"snapshots.aria": "立即创建当前配置的快照",
			"badge.count": "已存 {n} 份快照",
			"badge.just": "刚刚",
			"badge.min": "{n} 分钟前",
			"badge.hour": "{n} 小时前",
			"badge.day": "{n} 天前",
			"badge.title": "自动快照状态,点击打开快照管理",
			"ok.undo": "已撤销 → {id}",
			"ok.redo": "已重做",
			"ok.snapshot": "已存档 {id}",
			"err": "失败:{msg}",
			"err.busy": "有会话正在运行(agent 执行中),撤销/恢复会中断所有会话;请先等待当前任务结束或手动中断它,再重试。",
			"busy": "处理中…",
			"keys.undo": "撤销快捷键",
			"keys.redo": "恢复快捷键",
			"keys.none": "(未设置)",
			"keys.press": "请按组合键…",
			"keys.hint": "点击输入框后按下组合键;Backspace 清除;默认 Ctrl+Alt+Z / Ctrl+Alt+Y",
			"panel.title": "快照管理",
			"panel.profile": "profile: {profile}",
			"panel.profile.src": "· {src}",
			"panel.col.profile": "快照归属",
			"status.profile": "profile",
			"status.sensitive": "敏感模式",
			"status.sensitive.redact": "脱敏",
			"status.sensitive.keep": "明文",
			"status.size": "快照 / 占用",
			"status.last": "最近快照",
			"panel.search": "搜索类型 / 位置 / 原因",
			"panel.search.clear": "清空",
			"panel.view.table": "切到表格",
			"panel.view.cards": "切到卡片",
			"panel.select": "选择该快照",
			"panel.selected": "已选 {n} 条",
			"panel.batch.delete": "批量删除",
			"panel.batch.clear": "取消选择",
			"panel.confirm.batch": "确认删除选中的 {n} 条快照?此操作不可恢复。",
			"panel.noMatch": "没有匹配的快照",
			"panel.group.today": "今天",
			"panel.group.yesterday": "昨天",
			"panel.group.earlier": "更早",
			"panel.refresh": "刷新",
			"panel.save": "创建快照",
			"panel.restore": "回退所选",
			"panel.delete": "删除所选",
			"panel.close": "关闭",
			"panel.col.time": "时间",
			"panel.col.kind": "类型",
			"panel.col.reason": "原因",
			"panel.col.files": "文件",
			"panel.col.loc": "库",
			"panel.col.ops": "操作",
			"panel.op.restore": "恢复到此处",
			"panel.op.delete": "删除",
			"panel.op.diff": "对比",
			"panel.diff.title": "快照对比",
			"panel.diff.none": "(无差异)",
			"panel.cleanup": "清理过期快照",
			"panel.export": "导出",
			"panel.import": "导入",
			"ok.export": "已导出 {n} 个快照 → {path}",
			"export.sensitive.warn": "⚠️ 该导出包含真实密钥(.env / .credentials.yaml 处于 keep 模式或旧快照),请勿外传!",
			"ok.import": "已导入 {n} 个快照(跳过 {s} 个重复)",
			"boot.alert": "⚠️ 检测到上次 DSH 异常退出,建议回退到上次正常状态",
			"boot.crash.session": " 疑似会话文件损坏——对话/CLI 运行 undo_scan(quarantine=true)修复,或离线 dsh-undo.ps1 scan --fix",
			"boot.crash.bundle": " 疑似 bundle 清单校验失败——请进入安全模式后重启 DSH",
			"boot.crash.patch": " 疑似插件挂载/加载失败——建议回退到最近正常快照",
			"boot.rollback": "回退到最后正常状态",
			"restart.required": "已回退。重启 DSH 后恢复内容才会生效。",
			"safe.mode": "安全模式",
			"safe.on.confirm": "开启安全模式:除撤销系统外的所有用户插件将被临时禁用,并会中和会导致 DSH 无法启动的插件清单(bundle)条目(先自动快照并备份配置),重启 DSH 后生效。继续?",
			"safe.off.confirm": "退出安全模式:恢复进入前的完整插件配置,重启 DSH 后生效。继续?",
			"ok.prune": "已清理 {a} 个自动档、{p} 个后悔档",
			"settings.autoCleanup": "自动清理(超量自动删除)",
			"settings.keepPre": "后悔档保留数量",
			"settings.headerMode": "对话头按钮档位",
			"settings.headerMode.auto": "自动（按可用宽度）",
			"settings.headerMode.full": "完整（始终显示文字）",
			"settings.headerMode.compact": "紧凑（窄档只留撤销与菜单）",
			"settings.cleanupNote": "自动档保留 {keepAuto} 份;后悔档保留 {keepPre} 份;手动存档永不清除;关闭自动清理则全部保留",
			"panel.empty": "暂无快照。配置变化会自动存档;也可点「创建快照」立即存档。",
			"panel.confirm.restore": "确认回退到该快照?当前状态会先保存为后悔档,可再恢复。",
			"panel.confirm.delete": "确认删除该快照?此操作不可恢复。",
			"panel.updated": "已刷新 {n} 条",
			"type.manual": "手动",
			"type.auto": "自动",
			"type.baseline": "基线",
			"type.pre-restore": "后悔档",
			"loc.manual": "手动库",
			"loc.auto": "自动库",
			"loc.legacy": "旧库",
			"settings.title": "快照设置",
			"settings.nav": "快照",
			"settings.auto": "自动保存(配置变化自动存档)",
			"settings.debounce": "自动保存防抖(毫秒)",
			"settings.keep": "自动档保留数量",
			"settings.manualDir": "手动快照目录",
			"settings.autoDir": "自动快照目录",
			"settings.desktop": "桌面快捷方式",
			"settings.desktopInfo": "桌面目录",
			"settings.sensitive": "敏感模式",
			"settings.sensitive.redact": "脱敏(默认,值替换为***REDACTED***,本机回滚完整)",
			"settings.sensitive.keep": "明文(兼容旧行为,快照含真实值)",
			"settings.pluginDirs": "插件目录白名单(逗号分隔,留空=自动发现)",
			"settings.save": "保存设置",
			"settings.browse": "浏览并选择目录…",
			"settings.saved": "设置已保存并即时生效",
			"settings.error": "保存失败:{msg}",
			"export.pass": "加密密码(可选)",
			"export.encrypted": "已加密",
			"settings.schedule": "定时快照",
			"settings.schedule.enabled": "启用定时快照",
			"settings.schedule.ms": "间隔(分钟,≥1)",
			"settings.schedule.hint": "定时自动建档,间隔 ≥1 分钟;关闭则仅配置变更时自动存档",
			"settings.workspaceDirs": "跟踪工作区目录",
			"settings.workspaceDirs.hint": "逗号/分号分隔可多选;非空时覆盖默认工作目录(当前目录不再自动包含);留空=仅当前工作目录",
			"settings.bootHealth": "启动健康体检",
			"settings.upgradeGuard": "DSH 升级护航",
			"settings.autoSafeMode": "连续启动失败时自动进入安全模式（次数，0=关闭）",
			"settings.guardMode": "守卫发现启动受阻时",
			"settings.guardAsk": "询问（10 秒默认进入安全模式）",
			"settings.guardOn": "自动进入安全模式",
			"settings.guardOff": "只提醒不处理",
			"settings.guardShortcut": "创建「DSH 安全启动」桌面快捷方式（守卫入口）",
			"msg": "对话撤回",
			"msg.aria": "打开对话级撤回面板",
			"msg.title": "对话级撤回",
			"msg.empty": "暂无可撤回的消息批次",
			"msg.col.time": "时间",
			"msg.col.files": "文件",
			"msg.col.tools": "工具",
			"msg.col.ops": "操作",
			"msg.op.undo": "撤回",
			"msg.op.undoClick": "撤回该消息批次的文件改动?",
			"msg.ok": "已撤回该批次",
			"msg.err": "撤回失败:{msg}",
			"panel.instance": "实例",
			"panel.instance.current": "本机",
			"panel.instance.remote": "远端",
			"panel.instance.connect": "连接",
			"panel.instance.disconnect": "断开",
			"panel.instance.url": "远端地址（http://127.0.0.1:端口）",
			"panel.instance.token": "令牌",
			"panel.instance.add": "添加实例",
			"panel.instance.name": "名称",
			"panel.instance.home": "Home 路径",
			"panel.instance.save": "保存",
			"panel.instance.added": "已添加实例",
			"panel.instance.addFail": "添加失败：{msg}",
			"panel.instance.confirmRemove": "删除实例 {name}？",
			"panel.instance.store": "库",
			"panel.instance.settingsFile": "设置文件",
			"panel.instance.refresh": "重新读取",
			"panel.instance.fail": "连接失败：{msg}",
			"status.shared": "共享库",
			"status.shared.hint": "当前库未按 profile 分片，可能混有其他 profile 的快照",
			"flow.profile": "Profile",
			"flow.store": "快照库",
			"flow.switchProfile": "切换到 {profile} profile",
			"status.port": "端口",
			"status.scope": "库作用域",
			"status.scoped": "按 profile 分片",
			"status.custom": "自定义目录",
			"status.on": "开启",
			"status.off": "关闭",
			"status.loading": "正在读取…",
			"unknownProfile": "归属未知",
			"panel.showShared": "显示共享库全部",
			"panel.showShared.hint": "共享库未按 profile 分片;关闭时只显示当前 profile 与归属未知的快照",
			"panel.filter.kind": "类型筛选",
			"filter.all": "全部",
			"filter.preRestore": "撤销前",
			"filter.other": "其他",
			"panel.retry": "重试",
			"panel.loading": "正在读取快照…",
			"diff.none": "无差异",
			"diff.loading": "正在读取对比…",
			"diff.error": "对比读取失败",
			"diff.group.configs": "配置",
			"diff.group.plugins": "插件",
			"diff.group.profiles": "Profile 代码",
			"diff.group.other": "其他",
			"diff.expand": "展开",
			"diff.collapse": "折叠",
			"diff.fileCount": "{n} 个文件",
			"diff.linesHint": "快照 → 当前:红色为快照独有,绿色为当前新增",
			"settings.copy": "复制",
			"settings.copied": "已复制",
			"settings.currentInstance": "当前实例",
			"settings.currentProfile": "当前 profile",
			"safe.desktop.confirm": "桌面 profile 由宿主拒动,离线改写可能影响桌面启动;确认后会先自动快照并备份,重启后生效。继续?",
			"safe.ok.on": "已进入安全模式,重启 DSH 后生效",
			"safe.ok.off": "已退出安全模式,重启 DSH 后生效",
			"instance.busy": "有操作正在进行,已取消切换;稍后重试",
			"instance.mismatch": "端口与 home 不一致",
			"instance.mismatch.hint": "该端口实际指向的 home 与配置不一致,可能被其他实例占用",
			"online": "在线",
			"offline": "离线",
			"apiOld": "旧版接口",
			"apiOld.hint": "端口可连,但插件版本旧或未安装"
		};
		const en = {
			"undo": "Undo",
			"redo": "Redo",
			"snapshots": "Snapshots",
			"undo.aria": "Undo the last config change",
			"redo.aria": "Redo the last undone change",
			"snapshots.aria": "Create a snapshot of the current config now",
			"badge.count": "{n} snapshot(s)",
			"badge.just": "just now",
			"badge.min": "{n} min ago",
			"badge.hour": "{n} h ago",
			"badge.day": "{n} d ago",
			"badge.title": "Auto-snapshot status; click to open",
			"ok.undo": "Undone → {id}",
			"ok.redo": "Redone",
			"ok.snapshot": "Snapshot {id}",
			"err": "Failed: {msg}",
			"err.busy": "A session is running (agent in progress). Undo/redo would interrupt every session; wait for the task to finish or interrupt it first, then retry.",
			"busy": "Working…",
			"keys.undo": "Undo shortcut",
			"keys.redo": "Redo shortcut",
			"keys.none": "(unset)",
			"keys.press": "Press keys…",
			"keys.hint": "Click the box then press a combo; Backspace clears; defaults Ctrl+Alt+Z / Ctrl+Alt+Y",
			"panel.title": "Snapshot Manager",
			"panel.profile": "profile: {profile}",
			"panel.profile.src": "· {src}",
			"panel.col.profile": "Snapshot profile",
			"status.profile": "profile",
			"status.sensitive": "Sensitive mode",
			"status.sensitive.redact": "redacted",
			"status.sensitive.keep": "plaintext",
			"status.size": "snapshots / size",
			"status.last": "latest",
			"panel.search": "Search kind / location / reason",
			"panel.search.clear": "Clear",
			"panel.view.table": "Table view",
			"panel.view.cards": "Card view",
			"panel.select": "Select this snapshot",
			"panel.selected": "{n} selected",
			"panel.batch.delete": "Delete selected",
			"panel.batch.clear": "Clear selection",
			"panel.confirm.batch": "Delete {n} selected snapshots? This cannot be undone.",
			"panel.noMatch": "No snapshot matches",
			"panel.group.today": "Today",
			"panel.group.yesterday": "Yesterday",
			"panel.group.earlier": "Earlier",
			"panel.refresh": "Refresh",
			"panel.save": "Create snapshot",
			"panel.restore": "Restore",
			"panel.delete": "Delete",
			"panel.close": "Close",
			"panel.col.time": "Time",
			"panel.col.kind": "Type",
			"panel.col.reason": "Reason",
			"panel.col.files": "Files",
			"panel.col.loc": "Store",
			"panel.col.ops": "Actions",
			"panel.op.restore": "Restore to here",
			"panel.op.delete": "Delete",
			"panel.op.diff": "Compare",
			"panel.diff.title": "Snapshot compare",
			"panel.diff.none": "(no differences)",
			"panel.cleanup": "Prune expired",
			"panel.export": "Export",
			"panel.import": "Import",
			"ok.export": "Exported {n} snapshot(s) → {path}",
			"export.sensitive.warn": "⚠️ This archive contains REAL secrets (.env / .credentials.yaml in keep mode or legacy snapshots) — do NOT share it!",
			"ok.import": "Imported {n} snapshot(s) ({s} duplicate(s) skipped)",
			"boot.alert": "⚠️ Previous DSH run exited abnormally — roll back to the last good state",
			"boot.crash.session": " Likely session-file damage — run undo_scan (quarantine=true) in chat/CLI, or offline dsh-undo.ps1 scan --fix",
			"boot.crash.bundle": " Likely a profile-bundle hard-check failure — enable SAFE MODE and restart DSH",
			"boot.crash.patch": " Likely a plugin mount/load failure — roll back to a recent good snapshot",
			"boot.rollback": "Roll back to last good state",
			"restart.required": "Rolled back. A DSH restart is required for the restored state to take effect.",
			"safe.mode": "Safe mode",
			"safe.on.confirm": "Enable SAFE MODE? All user plugins except the undo system will be temporarily disabled, and profile bundles that would prevent DSH from booting will be neutralized (a snapshot and config backups are taken first). Takes effect after a DSH restart.",
			"safe.off.confirm": "Exit SAFE MODE? The full plugin set from before safe mode will be restored. Takes effect after a DSH restart.",
			"ok.prune": "Pruned {a} auto and {p} pre-restore snapshot(s)",
			"settings.autoCleanup": "Auto-cleanup (delete excess automatically)",
			"settings.keepPre": "Pre-restore snapshots kept",
			"settings.headerMode": "Header buttons",
			"settings.headerMode.auto": "Auto (fit the available width)",
			"settings.headerMode.full": "Full (always show labels)",
			"settings.headerMode.compact": "Compact (undo + menu only)",
			"settings.cleanupNote": "Auto keeps {keepAuto}, pre-restore keeps {keepPre}; manual snapshots are never deleted; disabling auto-cleanup keeps everything",
			"panel.empty": "No snapshots yet. Config changes auto-archive; or click Create snapshot.",
			"panel.confirm.restore": "Restore to this snapshot? Current state is kept as a redo point.",
			"panel.confirm.delete": "Delete this snapshot? This cannot be undone.",
			"panel.updated": "Refreshed {n} items",
			"type.manual": "Manual",
			"type.auto": "Auto",
			"type.baseline": "Baseline",
			"type.pre-restore": "Pre-restore",
			"loc.manual": "Manual",
			"loc.auto": "Auto",
			"loc.legacy": "Legacy",
			"settings.title": "Snapshot Settings",
			"settings.nav": "Snapshots",
			"settings.auto": "Auto-save (snapshot on config change)",
			"settings.debounce": "Auto-save debounce (ms)",
			"settings.keep": "Auto snapshots kept",
			"settings.manualDir": "Manual snapshot dir",
			"settings.autoDir": "Auto snapshot dir",
			"settings.desktop": "Desktop shortcut",
			"settings.desktopInfo": "Desktop dir",
			"settings.sensitive": "Sensitive mode",
			"settings.sensitive.redact": "Redact (default: values become ***REDACTED***, local rollback restores fully)",
			"settings.sensitive.keep": "Plaintext (legacy: snapshots hold real values)",
			"settings.pluginDirs": "Plugin dirs whitelist (comma-separated, empty = auto-detect)",
			"settings.save": "Save settings",
			"settings.browse": "Browse for directory…",
			"settings.saved": "Settings saved and applied",
			"settings.error": "Save failed: {msg}",
			"export.pass": "Password (optional, encrypts)",
			"export.encrypted": "encrypted",
			"settings.schedule": "Scheduled snapshots",
			"settings.schedule.enabled": "Enable scheduled snapshots",
			"settings.schedule.ms": "Interval (min, ≥1)",
			"settings.schedule.hint": "Auto-snapshot on a timer, interval ≥1 min; disabled means only config changes auto-snapshot",
			"settings.workspaceDirs": "Tracked workspace dirs",
			"settings.workspaceDirs.hint": "Comma/semicolon separated (multi-select); when non-empty it REPLACES the default current-dir scope; leave empty = current dir only",
			"settings.bootHealth": "Startup health check",
			"settings.upgradeGuard": "DSH upgrade guard",
			"settings.autoSafeMode": "Auto safe mode after N failed boots (0 = off)",
			"settings.guardMode": "When the guard finds boot blockers",
			"settings.guardAsk": "Ask (auto safe mode after 10s)",
			"settings.guardOn": "Enter safe mode automatically",
			"settings.guardOff": "Warn only",
			"settings.guardShortcut": "Create the \"DSH guarded launch\" desktop shortcut",
			"msg": "Message undo",
			"msg.aria": "Open message-level undo panel",
			"msg.title": "Message-level undo",
			"msg.empty": "No message batches to undo",
			"msg.col.time": "Time",
			"msg.col.files": "Files",
			"msg.col.tools": "Tools",
			"msg.col.ops": "Actions",
			"msg.op.undo": "Undo",
			"msg.op.undoClick": "Undo this batch's file changes?",
			"msg.ok": "Batch undone",
			"msg.err": "Undo failed: {msg}",
			"panel.instance": "Instance",
			"panel.instance.current": "Local",
			"panel.instance.remote": "Remote",
			"panel.instance.connect": "Connect",
			"panel.instance.disconnect": "Disconnect",
			"panel.instance.url": "Remote URL (http://127.0.0.1:port)",
			"panel.instance.token": "Token",
			"panel.instance.add": "Add instance",
			"panel.instance.name": "Name",
			"panel.instance.home": "Home path",
			"panel.instance.save": "Save",
			"panel.instance.added": "Instance added",
			"panel.instance.addFail": "Add failed: {msg}",
			"panel.instance.confirmRemove": "Remove instance {name}?",
			"panel.instance.store": "Store",
			"panel.instance.settingsFile": "Settings file",
			"panel.instance.refresh": "Reload",
			"panel.instance.fail": "Connect failed: {msg}",
			"status.shared": "Shared store",
			"status.shared.hint": "This store is not split by profile; snapshots from other profiles may be mixed in",
			"flow.profile": "Profile",
			"flow.store": "Snapshot store",
			"flow.switchProfile": "Switch to the {profile} profile",
			"status.port": "Port",
			"status.scope": "Store scope",
			"status.scoped": "Split by profile",
			"status.custom": "Custom dirs",
			"status.on": "On",
			"status.off": "Off",
			"status.loading": "Loading…",
			"unknownProfile": "Unknown profile",
			"panel.showShared": "Show all shared-store snapshots",
			"panel.showShared.hint": "The shared store is not split by profile; when off, only the current profile and unknown-profile snapshots are listed",
			"panel.filter.kind": "Filter by type",
			"filter.all": "All",
			"filter.preRestore": "Pre-restore",
			"filter.other": "Other",
			"panel.retry": "Retry",
			"panel.loading": "Loading snapshots…",
			"diff.none": "No differences",
			"diff.loading": "Loading comparison…",
			"diff.error": "Failed to load comparison",
			"diff.group.configs": "Configs",
			"diff.group.plugins": "Plugins",
			"diff.group.profiles": "Profile code",
			"diff.group.other": "Other",
			"diff.expand": "Expand",
			"diff.collapse": "Collapse",
			"diff.fileCount": "{n} file(s)",
			"diff.linesHint": "Snapshot → current: red = only in snapshot, green = new in current",
			"settings.copy": "Copy",
			"settings.copied": "Copied",
			"settings.currentInstance": "Current instance",
			"settings.currentProfile": "Current profile",
			"safe.desktop.confirm": "The desktop profile is refused by the host; offline edits may affect desktop startup. After you confirm, a snapshot and config backup are taken first and the change takes effect after a restart. Continue?",
			"safe.ok.on": "Safe mode ON; takes effect after a DSH restart",
			"safe.ok.off": "Safe mode OFF; takes effect after a DSH restart",
			"instance.busy": "An operation is in progress; the switch was cancelled. Try again later",
			"instance.mismatch": "Port/home mismatch",
			"instance.mismatch.hint": "The port actually points at a different home than configured; it may be occupied by another instance",
			"online": "Online",
			"offline": "Offline",
			"apiOld": "Legacy API",
			"apiOld.hint": "Port responds, but the plugin is old or not installed"
		};
		//#endregion
		//#region keyboard config (localStorage; shared with the settings row)
		const KEY_STORAGE = "dsh-undo-savepoint-keys";
		const DEFAULT_KEYS = {
			undo: { ctrl: true, alt: true, shift: false, key: "z" },
			redo: { ctrl: true, alt: true, shift: false, key: "y" }
		};
		function loadKeys() {
			try {
				const raw = localStorage.getItem(KEY_STORAGE);
				if (raw) {
					const j = JSON.parse(raw);
					return {
						undo: j && j.undo ? j.undo : DEFAULT_KEYS.undo,
						redo: j && j.redo ? j.redo : DEFAULT_KEYS.redo
					};
				}
			} catch (e) { /* fall through */ }
			return { undo: DEFAULT_KEYS.undo, redo: DEFAULT_KEYS.redo };
		}
		function saveKeys(keys) {
			try { localStorage.setItem(KEY_STORAGE, JSON.stringify(keys)); } catch (e) { /* ignore */ }
		}
		function formatKey(k) {
			if (!k || !k.key) return "";
			return [k.ctrl ? "Ctrl" : null, k.alt ? "Alt" : null, k.shift ? "Shift" : null, String(k.key).toUpperCase()].filter(Boolean).join("+");
		}
		function keyEventMatches(e, k) {
			if (!k || !k.key) return false;
			return !!e.ctrlKey === !!k.ctrl && !!e.altKey === !!k.alt && !!e.shiftKey === !!k.shift
				&& e.key.toLowerCase() === String(k.key).toLowerCase();
		}
		// W62：远端实例（连端口）。只在面板里显式连接后生效；本机配置接口不走代理。
		const REMOTE_STORAGE = "dsh-undo-savepoint-remote";
		function loadRemote() {
			try {
				const raw = localStorage.getItem(REMOTE_STORAGE);
				const v = raw ? JSON.parse(raw) : null;
				return v && typeof v.url === "string" && v.url ? v : null;
			} catch (e) { return null; }
		}
		function saveRemote(v) {
			try {
				if (v && v.url) localStorage.setItem(REMOTE_STORAGE, JSON.stringify({ url: v.url, token: v.token || "" }));
				else localStorage.removeItem(REMOTE_STORAGE);
			} catch (e) { /* 隐私模式忽略 */ }
		}
		function api(path, method, body) {
			const remote = loadRemote();
			if (remote && !path.startsWith("/api/undo/instances")) {
				return fetch("/api/undo/instances/proxy", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ url: remote.url, token: remote.token || "", path, method: method || "GET", body: body || null })
				}).then((r) => r.json()).then((j) => (j && j.ok ? j.data : { ok: false, error: (j && j.error) || { message: "remote proxy failed" } }))
					.catch((e) => ({ ok: false, error: { message: String(e && e.message || e) } }));
			}
			return fetch(path, {
				method: method || "GET",
				headers: body ? { "content-type": "application/json" } : undefined,
				body: body ? JSON.stringify(body) : undefined
			}).then((r) => r.json()).catch((e) => ({ ok: false, error: { message: String(e && e.message || e) } }));
		}
		const RESULT_EVENT = "dsh-undo-savepoint-result";
		/** After a successful undo/redo/restore the config files changed; the page
		 * reloads so the UI re-reads them (settings UI does not hot-follow files). */
		function maybeReload(r, label) {
			if (r && r.ok && !r.unchanged && (label === "undo" || label === "redo" || label === "restore")) {
				setTimeout(() => { try { location.reload(); } catch (e) { /* noop */ } }, 350);
			}
		}
		function publishResult(r, label) {
			let text = "";
			if (r && r.ok) {
				if (r.message) {
					text = r.message;
				} else {
					const id = r.targetId || (r.snapshot && r.snapshot.id) || "";
					text = label === "undo" ? (id ? "已撤销 → " + id : "已撤销") : label === "snapshot" ? ("已存档 " + id) : label === "redo" ? "已重做" : "已恢复到此处";
				}
			} else {
				text = "失败:" + ((r && (r.error && (r.error.message || r.error) || r)) || "unknown");
			}
			try { window.dispatchEvent(new CustomEvent(RESULT_EVENT, { detail: { ok: !!(r && r.ok), text } })); } catch (e) { /* noop */ }
		}
		const KIND_KEYS = { manual: "type.manual", auto: "type.auto", baseline: "type.baseline", "pre-restore": "type.pre-restore" };
		const KIND_FILTERS = ["all", "manual", "auto", "pre-restore", "other"]; // 类型筛选 chips（与搜索叠加）
		const LOC_KEYS = { manual: "loc.manual", auto: "loc.auto", legacy: "loc.legacy" };
		// ── W58：列表侧的纯函数。分组与搜索都在前端做，200 条量级不需要动接口 ──
		const PAGE_SIZE = 200; // 超过这个条数按批渲染，避免一次挂满 DOM
		const pad2 = (n) => String(n).padStart(2, "0");
		function localDayKey(v) {
			const d = v instanceof Date ? v : new Date(v);
			if (!Number.isFinite(d.getTime())) return "unknown";
			return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
		}
		// 与 W55 的 WebUI 时间线同口径：按本地时区算今天/昨天/更早，不截 ISO 串
		function dayBucketOf(v) {
			const d = new Date(v);
			if (!Number.isFinite(d.getTime())) return "earlier";
			const now = new Date();
			if (localDayKey(d) === localDayKey(now)) return "today";
			if (localDayKey(d) === localDayKey(new Date(now.getTime() - 86400000))) return "yesterday";
			return "earlier";
		}
		function filterSnaps(list, q) {
			const key = String(q ?? "").trim().toLowerCase();
			if (!key) return list;
			return list.filter((s) => [s.kind, s.location, s.reason, s.profile]
				.some((f) => String(f ?? "").toLowerCase().includes(key)));
		}
		function groupSnaps(list) {
			const order = ["today", "yesterday", "earlier"];
			const map = new Map();
			for (const s of list) {
				const k = dayBucketOf(s.time);
				if (!map.has(k)) map.set(k, []);
				map.get(k).push(s);
			}
			return order.filter((k) => map.has(k)).map((k) => ({ key: k, items: map.get(k) }));
		}
		function fmtBytes(n) {
			const v = Number(n) || 0;
			if (v < 1024) return v + " B";
			if (v < 1048576) return (v / 1024).toFixed(1) + " KB";
			return (v / 1048576).toFixed(2) + " MB";
		}
		//#endregion
		//#region UndoHeader (session header actions)
		/** 语义图标(单色 currentColor,随主题/按钮色自适应):撤销 ↶ / 恢复 ↷ / 相机。 */
		function UndoIcon({ size = 13 }) {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: size, height: size, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg",
				children: [
					(0, react_jsx_runtime.jsx)("path", { d: "M6.2 3.6 3.4 6.4l2.8 2.8", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" }),
					(0, react_jsx_runtime.jsx)("path", { d: "M3.4 6.4h6.1a3.2 3.2 0 0 1 0 6.4", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" })
				]
			});
		}
		function RedoIcon({ size = 13 }) {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: size, height: size, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg",
				children: [
					(0, react_jsx_runtime.jsx)("path", { d: "M9.8 3.6l2.8 2.8-2.8 2.8", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" }),
					(0, react_jsx_runtime.jsx)("path", { d: "M12.6 6.4H6.5a3.2 3.2 0 0 0 0 6.4", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" })
				]
			});
		}
		function CameraIcon({ size = 14 }) {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: size, height: size, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg",
				children: [
					(0, react_jsx_runtime.jsx)("path", { d: "M6 2.8h4v1.1h1.2c.94 0 1.7.76 1.7 1.7v5.5c0 .94-.76 1.7-1.7 1.7H4.8a1.7 1.7 0 0 1-1.7-1.7V5.6c0-.94.76-1.7 1.7-1.7h1.2z", fill: "currentColor" }),
					(0, react_jsx_runtime.jsx)("path", { d: "M8 6.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6zm0 .9a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8z", fill: "currentColor", fillRule: "evenodd" })
				]
			});
		}
		/** 相对时间文案(徽章用):刚刚 / N 分钟前 / N 小时前 / N 天前。 */
		function relativeTime(ts, t) {
			if (!ts) return null;
			const diff = Date.now() - new Date(ts).getTime();
			if (diff < 60 * 1000) return t("badge.just");
			const min = Math.floor(diff / 60000);
			if (min < 60) return t("badge.min", { n: min });
			const hr = Math.floor(min / 60);
			if (hr < 24) return t("badge.hour", { n: hr });
			return t("badge.day", { n: Math.floor(hr / 24) });
		}
		/** Undo/redo/snapshot buttons in the conversation header. */
		function UndoHeader({ t, onOpenPanel }) {
			const [busy, setBusy] = (0, react.useState)(false);
			const [msg, setMsg] = (0, react.useState)(null);
			const [msgOk, setMsgOk] = (0, react.useState)(true);
			const [msgOpen, setMsgOpen] = (0, react.useState)(false);
			const timer = (0, react.useRef)(null);
			const keys = loadKeys();
			// W74（#50）：对话头档位。设置读不到（旧服务端 / 接口失败 / 非法值）时一律按 auto 渲染，
			// 头按钮永远可用；full / compact 由 data-undo-mode 强制，auto 交给容器查询。
			const [headerMode, setHeaderMode] = (0, react.useState)("auto");
			(0, react.useEffect)(() => {
				let alive = true;
				api("/api/undo/settings").then((r) => {
					if (!alive) return;
					const m = r && r.ok && r.settings ? r.settings.headerMode : null;
					setHeaderMode(m === "full" || m === "compact" ? m : "auto");
				}).catch(() => { /* 保持 auto */ });
				return () => { alive = false; };
			}, []);
			const [menuOpen, setMenuOpen] = (0, react.useState)(false);
			// 状态徽章:总数(/api/undo/status)+ 最新快照时间(/api/undo/list 首条),30s 轮询
			const [stat, setStat] = (0, react.useState)(null);
			const refreshStat = (0, react.useCallback)(async () => {
				const r = await api("/api/undo/status");
				if (!(r && r.ok)) return;
				const l = await api("/api/undo/list");
				const latest = l && l.ok && l.snapshots && l.snapshots.length ? l.snapshots[0].time : null;
				setStat({ total: r.total, latest });
			}, []);
			const flash = (ok, text) => {
				setMsg(text);
				setMsgOk(ok);
				if (timer.current) clearTimeout(timer.current);
				timer.current = setTimeout(() => setMsg(null), 6000);
			};
			const run = async (label, path) => {
				if (busy) return;
				setBusy(true);
				try {
					const r = await api(path, "POST");
					publishResult(r, label);
					maybeReload(r, label);
					let text;
					if (r && r.ok) {
						text = r.message || (label === "undo" ? t("ok.undo", { id: r.targetId || "" }) : label === "redo" ? t("ok.redo") : t("ok.snapshot", { id: (r && r.snapshot && r.snapshot.id) || "" }));
					} else if (r && r.error && r.error.code === 'busy') {
						text = t("err.busy");
					} else {
						text = t("err", { msg: (r && (r.error && (r.error.message || r.error))) || "unknown" });
					}
					flash(!!(r && r.ok), text);
					// 手动快照落地后立刻刷新徽章(不用等 30s 轮询)
					if (label === "snapshot" && r && r.ok) refreshStat();
				} finally {
					setBusy(false);
				}
			};
			(0, react.useEffect)(() => {
				const onResult = (ev) => {
					const d = ev && ev.detail;
					if (!d) return;
					flash(d.ok, d.text);
				};
				window.addEventListener(RESULT_EVENT, onResult);
				return () => {
					window.removeEventListener(RESULT_EVENT, onResult);
					if (timer.current) clearTimeout(timer.current);
				};
			}, []);
			(0, react.useEffect)(() => {
				refreshStat();
				const id = setInterval(refreshStat, 30000);
				return () => clearInterval(id);
			}, [refreshStat]);
			return (0, react_jsx_runtime.jsx)("div", {
				className: styles.actions,
				"data-undo-header": true,
				"data-undo-mode": headerMode === "auto" ? undefined : headerMode,
				children: [
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: styles.btn + " " + styles.undo,
						disabled: busy,
						title: t("undo.aria") + (keys.undo ? " (" + formatKey(keys.undo) + ")" : ""),
						"aria-label": t("undo.aria"),
						onClick: () => { run("undo", "/api/undo/undo"); },
						children: [(0, react_jsx_runtime.jsx)(UndoIcon, { size: 13 }), (0, react_jsx_runtime.jsx)("span", { className: styles.label, children: t("undo") })]
					}),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: styles.btn + " " + styles.redo + " " + styles.mid,
						disabled: busy,
						title: t("redo.aria") + (keys.redo ? " (" + formatKey(keys.redo) + ")" : ""),
						"aria-label": t("redo.aria"),
						onClick: () => { run("redo", "/api/undo/redo"); },
						children: [(0, react_jsx_runtime.jsx)(RedoIcon, { size: 13 }), (0, react_jsx_runtime.jsx)("span", { className: styles.label, children: t("redo") })]
					}),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: styles.btn + " " + styles.list + " " + styles.mid,
						disabled: busy,
						title: t("snapshots.aria"),
						"aria-label": t("snapshots.aria"),
						onClick: () => { run("snapshot", "/api/undo/snapshot"); },
						children: [(0, react_jsx_runtime.jsx)(CameraIcon, { size: 14 }), (0, react_jsx_runtime.jsx)("span", { className: styles.label, children: t("snapshots") })]
					}),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: styles.btn + " " + styles.list + " " + styles.mid,
						title: t("msg.aria"),
						"aria-label": t("msg.aria"),
						onClick: () => { setMsgOpen(true); },
						children: (0, react_jsx_runtime.jsx)("span", { className: styles.label, children: t("msg") })
					}),
					stat !== null && (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: styles.badge + " " + styles.mid,
						title: t("badge.title"),
						"aria-label": t("badge.title"),
						onClick: () => { onOpenPanel(); },
						children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.dot }),
							t("badge.count", { n: stat.total }),
							stat.latest ? " · " + (0, react_jsx_runtime.jsx)("span", { className: styles.badgeTime, children: relativeTime(stat.latest, t) || "" }) : ""
						]
					}),
					msg !== null && (0, react_jsx_runtime.jsx)("span", {
						className: styles.msg + " " + (msgOk ? styles.ok : styles.err),
						children: msg
					}),
					msgOpen && (0, react_jsx_runtime.jsx)(MessagePanel, { onClose: () => setMsgOpen(false), t }),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: styles.btn + " " + styles.menuBtn,
						title: t("panel.title"),
						"aria-label": t("panel.title"),
						onClick: () => { setMenuOpen(true); },
						children: "⋯"
					}),
					menuOpen && (0, react_jsx_runtime.jsx)(UndoMenu, {
						t,
						busy,
						onClose: () => setMenuOpen(false),
						onUndo: () => { setMenuOpen(false); run("undo", "/api/undo/undo"); },
						onRedo: () => { setMenuOpen(false); run("redo", "/api/undo/redo"); },
						onSnapshot: () => { setMenuOpen(false); run("snapshot", "/api/undo/snapshot"); },
						onMessages: () => { setMenuOpen(false); setMsgOpen(true); },
						onPanel: () => { setMenuOpen(false); onOpenPanel(); }
					})
				]
			});
		}
		//#endregion

		/**
		 * W74（#50）：窄档单入口菜单。复用 overlay / panel 既有样式，条目直接调现成的 run 与
		 * onOpenPanel，不新增动作路径；overlay 同样走 UndoLayer，避免被头部容器裁切。
		 */
		function UndoMenu({ t, busy, onClose, onUndo, onRedo, onSnapshot, onMessages, onPanel }) {
			const item = (label, onClick) => (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: styles.btn + " " + styles.menuItem,
				disabled: busy,
				onClick,
				children: label
			});
			return (0, react_jsx_runtime.jsx)(UndoLayer, { children: (0, react_jsx_runtime.jsx)("div", {
				className: styles.overlay,
				"data-undo-menu": true,
				onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
				children: (0, react_jsx_runtime.jsx)("div", { className: styles.panel, children: [
					(0, react_jsx_runtime.jsx)("div", { className: styles.head, children: [
						(0, react_jsx_runtime.jsx)("span", { className: styles.title, children: t("panel.title") }),
						(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.close, onClick: onClose, children: "×" })
					] }),
					(0, react_jsx_runtime.jsx)("div", { className: styles.menuList, children: [
						item(t("undo"), onUndo),
						item(t("redo"), onRedo),
						item(t("snapshots"), onSnapshot),
						item(t("msg"), onMessages),
						item(t("panel.title"), onPanel)
					] })
				] })
			}) });
		}

		//#region MessagePanel
		/** V0.4.0 局内对话级撤回：列出消息批次并支持一键撤回文件改动。 */
		function MessagePanel({ onClose, t }) {
			const [list, setList] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [msg, setMsg] = (0, react.useState)(null);
			const [msgOk, setMsgOk] = (0, react.useState)(true);
			const load = (0, react.useCallback)(async () => {
				const r = await api("/api/undo/messages");
				if (r && r.ok) setList(r.messages || []);
			}, []);
			(0, react.useEffect)(() => { load(); }, [load]);
			const undo = async (item) => {
				if (busy) return;
				setBusy(true);
				try {
					const r = await api("/api/undo/message", "POST", { id: item.id });
					if (r && r.ok) { setMsgOk(true); setMsg(t("msg.ok")); load(); publishResult(r, "message"); }
					else { setMsgOk(false); setMsg(t("msg.err", { msg: (r && (r.error && (r.error.message || r.error))) || "unknown" })); }
				} finally { setBusy(false); }
			};
			const rows = (list || []).map((it) => (0, react_jsx_runtime.jsx)("tr", {
				children: [
					(0, react_jsx_runtime.jsx)("td", { className: styles.time, children: relativeTime(it.startedAt || it.id, t) }),
					(0, react_jsx_runtime.jsx)("td", { children: it.files }),
					(0, react_jsx_runtime.jsx)("td", { className: styles.reason, children: (it.tools || []).join(", ") }),
					(0, react_jsx_runtime.jsx)("td", { className: styles.kind, children: (0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn + " " + styles.undo, disabled: busy, onClick: () => undo(it), children: t("msg.op.undo") }) })
				]
			}, it.id));
			let content;
			if (list === null) content = (0, react_jsx_runtime.jsx)("div", { className: styles.empty, children: t("busy") });
			else if (list.length === 0) content = (0, react_jsx_runtime.jsx)("div", { className: styles.empty, children: t("msg.empty") });
			else content = (0, react_jsx_runtime.jsx)("table", { className: styles.table, children: [
				(0, react_jsx_runtime.jsx)("thead", { children: (0, react_jsx_runtime.jsx)("tr", { children: [
					(0, react_jsx_runtime.jsx)("th", { children: t("msg.col.time") }),
					(0, react_jsx_runtime.jsx)("th", { children: t("msg.col.files") }),
					(0, react_jsx_runtime.jsx)("th", { children: t("msg.col.tools") }),
					(0, react_jsx_runtime.jsx)("th", { children: t("msg.col.ops") })
				] }) }),
				(0, react_jsx_runtime.jsx)("tbody", { children: rows })
			] });
			return (0, react_jsx_runtime.jsx)(UndoLayer, { children: (0, react_jsx_runtime.jsx)("div", {
				className: styles.overlay,
				"data-undo-msg-panel": true,
				onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
				children: (0, react_jsx_runtime.jsx)("div", { className: styles.panel, children: [
					(0, react_jsx_runtime.jsx)("div", { className: styles.head, children: [
						(0, react_jsx_runtime.jsx)("span", { className: styles.title, children: t("msg.title") }),
						(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.close, onClick: onClose, children: "×" })
					] }),
					msg !== null && (0, react_jsx_runtime.jsx)("div", { className: styles.foot, children: (0, react_jsx_runtime.jsx)("span", { className: styles.msg + " " + (msgOk ? styles.ok : styles.err), children: msg }) }),
					(0, react_jsx_runtime.jsx)("div", { className: styles.tbody, children: content })
				] })
			}) });
		}
		//#endregion
		//#region DiffOverlay v2
		/** 快照对比浮层：configs / plugins / profiles 三组文件，逐文件 +N/−N 与红绿行。 */
		function DiffOverlay({ diff, t, collapsed, onToggleFile, onClose, onRetry }) {
			(0, react.useEffect)(() => {
				const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onClose]);
			const buckets = [
				{ key: "configs", label: t("diff.group.configs"), items: [] },
				{ key: "plugins", label: t("diff.group.plugins"), items: [] },
				{ key: "profiles", label: t("diff.group.profiles"), items: [] },
				{ key: "other", label: t("diff.group.other"), items: [] }
			];
			const byKey = {};
			for (const b of buckets) byKey[b.key] = b;
			for (const f of (diff && diff.items) || []) {
				const name = String(f.name || "");
				const key = f.group === "configs" || f.group === "plugins" || f.group === "profiles" || f.group === "other"
					? f.group
					: name.startsWith("plugin:") ? "plugins" : name.startsWith("profile:") ? "profiles" : "configs";
				byKey[key].items.push(f);
			}
			const total = diff && diff.items ? diff.items.length : 0;
			const isOpen = (f) => !(collapsed && collapsed[f.name]);
			const lineEl = (f, l, kind, i) => {
				const note = String(l).startsWith("(");
				if (note) return (0, react_jsx_runtime.jsx)("span", { className: styles.diffLine + " " + styles.diffLineCtx, children: "· " + l }, f.name + "-" + kind + i);
				return (0, react_jsx_runtime.jsx)("span", { className: styles.diffLine + " " + (kind === "add" ? styles.diffLineAdd : styles.diffLineDel), children: (kind === "add" ? "+ " : "− ") + l }, f.name + "-" + kind + i);
			};
			const files = [];
			const nav = [];
			for (const b of buckets) {
				if (b.items.length === 0) continue;
				nav.push({ group: b.label + " · " + t("diff.fileCount", { n: b.items.length }), key: "g:" + b.key });
				for (const f of b.items) {
					nav.push({ file: f, index: files.length, key: "f:" + f.name });
					files.push(f);
				}
			}
			const [active, setActive] = (0, react.useState)(0);
			(0, react.useEffect)(() => { setActive(0); }, [diff && diff.id]);
			const activeIndex = Math.min(active, Math.max(0, files.length - 1));
			const activeFile = files[activeIndex] || null;
			let body;
			if (diff && diff.loading) {
				body = (0, react_jsx_runtime.jsx)("div", { className: styles.skel, "aria-label": t("diff.loading"), children: [
					(0, react_jsx_runtime.jsx)("span", { className: styles.skelLine }),
					(0, react_jsx_runtime.jsx)("span", { className: styles.skelLine }),
					(0, react_jsx_runtime.jsx)("span", { className: styles.skelLine })
				] });
			} else if (diff && diff.error) {
				body = (0, react_jsx_runtime.jsx)("div", { className: styles.state, children: [
					(0, react_jsx_runtime.jsx)("span", { className: styles.stateIcon, children: "⚠" }),
					(0, react_jsx_runtime.jsx)("span", { className: styles.stateText, children: t("diff.error") + ": " + diff.error }),
					(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.statePrimary, onClick: onRetry, children: t("panel.retry") })
				] });
			} else if (total === 0) {
				body = (0, react_jsx_runtime.jsx)("div", { className: styles.state, children: [
					(0, react_jsx_runtime.jsx)("span", { className: styles.stateIcon, children: "✓" }),
					(0, react_jsx_runtime.jsx)("span", { className: styles.stateText, children: t("diff.none") })
				] });
			} else {
				body = (0, react_jsx_runtime.jsxs)("div", { className: styles.diffBodyPane, children: [
					(0, react_jsx_runtime.jsxs)("div", { className: styles.diffNav, role: "tablist", "aria-label": t("panel.diff.title"), children: [
						...nav.map((n) => n.group ? (0, react_jsx_runtime.jsx)("div", { className: styles.diffNavGroup, children: n.group }, n.key) : (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							role: "tab",
							className: styles.diffNavFile + (n.index === activeIndex ? " " + styles.diffNavOn : ""),
							"aria-selected": n.index === activeIndex,
							"data-undo-diff-file": n.file.name,
							title: n.file.name,
							onClick: () => setActive(n.index),
							children: [
								(0, react_jsx_runtime.jsx)("span", { className: styles.diffNavName, children: n.file.name }),
								(0, react_jsx_runtime.jsx)("span", { className: styles.diffAddStat, children: "+" + (Number(n.file.added) || 0) }),
								(0, react_jsx_runtime.jsx)("span", { className: styles.diffDelStat, children: "−" + (Number(n.file.removed) || 0) })
							]
						}, n.key))
					] }),
					(0, react_jsx_runtime.jsx)("div", { className: styles.diffView, children: activeFile === null ? null : [
						(0, react_jsx_runtime.jsxs)("div", { className: styles.diffViewHead, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.diffPath, title: activeFile.name, children: activeFile.name }),
							(0, react_jsx_runtime.jsx)("span", { className: styles.diffAddStat, children: "+" + (Number(activeFile.added) || 0) }),
							(0, react_jsx_runtime.jsx)("span", { className: styles.diffDelStat, children: "−" + (Number(activeFile.removed) || 0) }),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: styles.diffToggle,
								"aria-expanded": isOpen(activeFile),
								onClick: () => onToggleFile(activeFile.name),
								children: isOpen(activeFile) ? t("diff.collapse") : t("diff.expand")
							})
						] }),
						(0, react_jsx_runtime.jsxs)("div", { className: styles.diffViewBody, children: [
							(0, react_jsx_runtime.jsx)("div", { className: styles.diffNote, children: t("diff.linesHint") }),
							isOpen(activeFile) && (0, react_jsx_runtime.jsx)("div", { className: styles.diffLines, children: [
								...((activeFile.removedLines || []).map((l, i) => lineEl(activeFile, l, "del", i))),
								...((activeFile.addedLines || []).map((l, i) => lineEl(activeFile, l, "add", i)))
							] })
						] })
					] })
				] });
			}
			return (0, react_jsx_runtime.jsx)("div", {
				className: styles.diffOverlay,
				"data-undo-diff": true,
				onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); },
				children: (0, react_jsx_runtime.jsxs)("div", {
					className: styles.diffPanel,
					role: "dialog",
					"aria-modal": "true",
					"aria-label": t("panel.diff.title") + " · " + (diff ? diff.id : ""),
					children: [
						(0, react_jsx_runtime.jsxs)("div", { className: styles.diffHead, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.diffTitle, children: t("panel.diff.title") + " · " + (diff ? diff.id : "") }),
							(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.close, "aria-label": t("panel.close"), onClick: onClose, children: "×" })
						] }),
						body
					]
				})
			});
		}
		//#endregion
		//#region SnapshotPanel
		/** Modal snapshot manager: list, restore-to-version, delete, manual save. */
		function SnapshotPanel({ onClose, t }) {
			const [snaps, setSnaps] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [msg, setMsg] = (0, react.useState)(null);
			const [msgOk, setMsgOk] = (0, react.useState)(true);
			const [diff, setDiff] = (0, react.useState)(null); // {id, items, loading, error} 对比浮层
			const [diffCollapsed, setDiffCollapsed] = (0, react.useState)({}); // 对比浮层里折叠的文件
			const [showShared, setShowShared] = (0, react.useState)(false); // 关：只显示当前 profile 与归属未知
			const [kindFilter, setKindFilter] = (0, react.useState)("all"); // 类型筛选 chips
			const [counts, setCounts] = (0, react.useState)(null); // list 响应的 countByProfile，用于共享库计数提示
			const [bootAlert, setBootAlert] = (0, react.useState)(null); // { lastGoodSnapshotId, crashReason } | null
			const [profileNow, setProfileNow] = (0, react.useState)(null); // { name, src } 取自 /api/undo/status 的实时 profile（W53）
			const [statusNow, setStatusNow] = (0, react.useState)(null); // /api/undo/status 原样，库根与共享标志从这取
			const [loadError, setLoadError] = (0, react.useState)(null); // 列表拉取失败：三态里的错误态
			const [instances, setInstances] = (0, react.useState)(null); // 本机实例列表（/api/undo/instances）
			const [remote, setRemote] = (0, react.useState)(loadRemote()); // 远端连接（localStorage）
			const [remoteOpen, setRemoteOpen] = (0, react.useState)(false);
			const [remoteUrl, setRemoteUrl] = (0, react.useState)(remote && remote.url ? remote.url : "http://127.0.0.1:");
			const [remoteToken, setRemoteToken] = (0, react.useState)(remote && remote.token ? remote.token : "");
			const [remoteMsg, setRemoteMsg] = (0, react.useState)(null);
			const [instOpen, setInstOpen] = (0, react.useState)(false);
			const [instName, setInstName] = (0, react.useState)("");
			const [instHome, setInstHome] = (0, react.useState)("");
			const [instMsg, setInstMsg] = (0, react.useState)(null);
			const [settings, setSettings] = (0, react.useState)(null); // 敏感模式等，状态条用
			const [view, setView] = (0, react.useState)("cards"); // W58：默认卡片，表格保留为可切换项
			const [query, setQuery] = (0, react.useState)(""); // 搜索关键字：kind / location / reason
			const [selected, setSelected] = (0, react.useState)([]); // 批量操作的多选 id
			const [page, setPage] = (0, react.useState)(0); // 200 条以上按批渲染的当前批
			const [pass, setPass] = (0, react.useState)(''); // 导出/导入加密密码(可选)
			const load = (0, react.useCallback)(async () => {
				const r = await api("/api/undo/list");
				setLoadError(r && r.ok ? null : ((r && r.error && (r.error.message || r.error)) || "list failed"));
				setSnaps(r && r.ok ? (r.snapshots || []) : []);
				setCounts(r && r.ok && r.countByProfile ? r.countByProfile : null);
				const st = await api("/api/undo/status");
				setBootAlert(st && st.ok && st.bootAlert ? { lastGoodSnapshotId: st.lastGoodSnapshotId || null, crashReason: st.crashReason || null } : null);
				// W53：面板副标题的 profile 取实时值，不再用最新快照里冻结的归属字段
				setProfileNow(st && st.ok && st.profileName ? { name: st.profileName, src: st.profileSource || null } : null);
				setStatusNow(st && st.ok ? st : null);
				const se = await api("/api/undo/settings");
				setSettings(se && se.ok ? se.settings : null);
				const ii = await api("/api/undo/instances");
				setInstances(ii && ii.ok ? ii : null);
			}, []);
			(0, react.useEffect)(() => { load(); }, [load]);
			const act = async (label, path, body) => {
				if (busy) return;
				setBusy(true);
				try {
					const r = await api(path, "POST", body);
					publishResult(r, label);
					maybeReload(r, label);
					if (r && r.ok && r.needsRestart) window.alert(t("restart.required"));
					setMsgOk(!!(r && r.ok));
					if (r && r.ok) {
						setMsg(r.message || t("ok.undo", { id: r.targetId || "" }));
					} else if (r && r.error && r.error.code === 'busy') {
						setMsg(t("err.busy"));
					} else {
						setMsg(t("err", { msg: (r && (r.error && (r.error.message || r.error))) || "unknown" }));
					}
					await load();
				} finally {
					setBusy(false);
				}
			};
			const fetchDiff = async (id) => {
				const r = await api("/api/undo/diff?id=" + encodeURIComponent(id));
				return r && r.ok ? (r.diff || []) : [];
			};
			const restoreOne = async (s) => {
				// preview the differences first, then confirm with a summary
				const items = await fetchDiff(s.id);
				const summary = items.length === 0
					? t("panel.diff.none")
					: items.map((f) => "  " + f.name + "  +" + f.added + " -" + f.removed).join("\n");
				if (!window.confirm(t("panel.confirm.restore") + "\n\n" + summary)) return;
				act("restore", "/api/undo/restore", { id: s.id });
			};
			const showDiff = async (s) => {
				setDiff({ id: s.id, items: [], loading: true, error: null });
				setDiffCollapsed({});
				const r = await api("/api/undo/diff?id=" + encodeURIComponent(s.id));
				if (r && r.ok) {
					setDiff({ id: s.id, items: r.diff || [], loading: false, error: null });
				} else {
					setDiff({ id: s.id, items: [], loading: false, error: (r && (r.error && (r.error.message || r.error))) || "diff failed" });
				}
			};
			const toggleSafeMode = async () => {
				if (busy) return;
				const target = profile || "web";
				const st = await api("/api/undo/safe-mode", "POST", { action: "status" });
				const on = !!(st && st.ok && st.active);
				const action = on ? "off" : "on";
				const desktop = target === "desktop";
				// desktop：文案写明宿主拒动、离线改写风险、先快照备份、重启生效；取消即什么都不做。
				if (!window.confirm(desktop ? t("safe.desktop.confirm") : (on ? t("safe.off.confirm") : t("safe.on.confirm")))) return;
				let r = await api("/api/undo/safe-mode", "POST", desktop ? { action, profile: target, confirmDesktop: true } : { action, profile: target });
				// 服务端判定需要确认（needConfirm）时同样走二次确认，再带 confirmDesktop 重试。
				if (r && r.ok === false && r.needConfirm) {
					if (!window.confirm(t("safe.desktop.confirm"))) return;
					r = await api("/api/undo/safe-mode", "POST", { action, profile: target, confirmDesktop: true });
				}
				setMsgOk(!!(r && r.ok));
				setMsg(r && r.ok ? (r.message || t(action === "on" ? "safe.ok.on" : "safe.ok.off")) : t("err", { msg: (r && (r.error && (r.error.message || r.error))) || "unknown" }));
				if (r && r.ok) {
					if (r.needsRestart) window.alert(t("restart.required"));
					await load();
				}
			};
			const deleteOne = (s) => {
				if (!window.confirm(t("panel.confirm.delete"))) return;
				act("delete", "/api/undo/remove", { id: s.id });
			};
			// W58：批量与键盘。批量删除沿用单条的二次确认，取消即不删。
			const toggleSel = (id) => setSelected((cur) => (cur.indexOf(id) >= 0 ? cur.filter((x) => x !== id) : cur.concat([id])));
			const deleteSelected = async () => {
				if (!selected.length || busy) return;
				if (!window.confirm(t("panel.confirm.batch", { n: selected.length }))) return;
				setBusy(true);
				try {
					for (const id of selected) {
						const r = await api("/api/undo/remove", "POST", { id });
						setMsgOk(!!(r && r.ok));
					}
				} finally {
					setSelected([]);
					setBusy(false);
					await load();
				}
			};
			// 键盘按普遍操作习惯：方向键上下移动焦点、Enter 打开 diff、Delete 删除（需确认）
			const onCardKey = (e, s) => {
				if (e.key === "Enter") { e.preventDefault(); showDiff(s); return; }
				if (e.key === "Delete") { e.preventDefault(); deleteOne(s); return; }
				if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
				e.preventDefault();
				const nodes = Array.prototype.slice.call(document.querySelectorAll("[data-undo-card]"));
				const idx = nodes.indexOf(e.currentTarget);
				const n = (idx + (e.key === "ArrowDown" ? 1 : -1) + nodes.length) % nodes.length;
				if (nodes[n] && nodes[n].focus) nodes[n].focus();
			};
			const saveNow = async () => {
				await act("save", "/api/undo/snapshot", { reason: "manual:ui" });
				await load();
			};
			const cleanupNow = async () => {
				const r = await api("/api/undo/prune", "POST");
				setMsgOk(!!(r && r.ok));
				setMsg(r && r.ok ? t("ok.prune", { a: r.removedAuto || 0, p: r.removedPre || 0 }) : t("err", { msg: (r && (r.error && (r.error.message || r.error))) || "unknown" }));
				await load();
			};
			const exportNow = async () => {
				const r = await api("/api/undo/export", "POST", { password: pass });
				setMsgOk(!!(r && r.ok));
				if (r && r.ok && r.sensitiveWarning) window.alert(t("export.sensitive.warn"));
				const enc = r && r.ok && r.encrypted ? " · " + t("export.encrypted") : "";
				setMsg(r && r.ok ? t("ok.export", { n: r.count || 0, path: r.path || "" }) + enc : t("err", { msg: (r && (r.error && (r.error.message || r.error))) || "unknown" }));
			};
			const importNow = async () => {
				const picked = await api("/api/undo/pick-file", "POST", {});
				if (!(picked && picked.ok && picked.path)) return;
				const r = await api("/api/undo/import", "POST", { path: picked.path, password: pass });
				setMsgOk(!!(r && r.ok));
				setMsg(r && r.ok ? t("ok.import", { n: r.imported || 0, s: r.skipped || 0 }) : t("err", { msg: (r && (r.error && (r.error.message || r.error))) || "unknown" }));
				await load();
			};
			// 面板副标题:W53 起取 /api/undo/status 的实时 profile(profileName/profileSource)。
			// 老服务端没有这两个字段时回落首条快照 manifest 里冻结的归属,那只是兜底,可能已经过时。
			const profile = profileNow && profileNow.name ? profileNow.name : (snaps && snaps.length ? (snaps[0].profile || null) : null);
			const profileSrc = profileNow && profileNow.name ? (profileNow.src || null) : null;
			// W58：列表侧派生。搜索与分组都按本地时区口径，与 W55 的时间线一致。
			const all = snaps || [];
			// W62：库根绑定校验。shared 说明库未按 profile 分片，profilesSeen 是列表里实际出现的归属。
			const storeShared = !!(statusNow && statusNow.sharedStore);
			const storeRoot = statusNow && statusNow.storeRoot ? String(statusNow.storeRoot) : "";
			const instanceNameNow = statusNow && statusNow.instanceName ? String(statusNow.instanceName) : "";
			const profilesSeen = new Set(all.map((s) => s.profile).filter(Boolean));
			// 归属过滤：关掉「显示共享库全部」时，共享库里别的 profile 快照先隐藏；profileMatch=null（归属未知）默认保留。
			const matchByProfile = (s) => s.profileMatch === true || s.profileMatch === null || (s.profileMatch === undefined && (!s.profile || s.profile === profile));
			const inScope = showShared ? all : all.filter(matchByProfile);
			const byKind = kindFilter === "all" ? inScope : inScope.filter((s) => (kindFilter === "other" ? ["manual", "auto", "pre-restore"].indexOf(s.kind) < 0 : s.kind === kindFilter));
			const visible = filterSnaps(byKind, query);
			const groups = groupSnaps(visible);
			const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
			const pageSafe = Math.min(page, pageCount - 1);
			const shown = visible.slice(pageSafe * PAGE_SIZE, pageSafe * PAGE_SIZE + PAGE_SIZE);
			const shownGroups = groupSnaps(shown); // 卡片也按批挂载，300 条不会一次铺满 DOM
			const libBytes = all.reduce((n, s) => n + (Number(s.totalBytes) || 0), 0);
			const lastAt = all.length > 0 && all[0].time ? all[0].time : null;
			// 第二轮：流程条/状态条派生。端口与 profile 列表都取 status 的实时值，缺字段时给安全回落。
			const statusPort = statusNow && statusNow.port !== null && statusNow.port !== undefined && Number.isFinite(Number(statusNow.port)) ? Number(statusNow.port) : (statusNow && statusNow.instancePort ? Number(statusNow.instancePort) : null);
			const storeScope = statusNow && statusNow.profileDetail && statusNow.profileDetail.storeScope ? String(statusNow.profileDetail.storeScope) : (statusNow && statusNow.storeScope ? String(statusNow.storeScope) : "");
			const storeScopeLabel = storeShared ? t("status.shared") : (storeScope === "custom" ? t("status.custom") : t("status.scoped"));
			const profileNames = (statusNow && Array.isArray(statusNow.profiles) && statusNow.profiles.length ? statusNow.profiles : ["web", "desktop"]).filter((p) => typeof p === "string" && p !== "");
			const currentProfileName = profile || profileNames[0] || "web";
			const safeModeNow = statusNow && typeof statusNow.safeModeActive === "boolean" ? statusNow.safeModeActive : null;
			// 切 profile：POST /api/undo/instances {switch:{profile}}，成功后整页重载（库根与服务端状态一起刷新）。
			const switchProfile = async (next) => {
				if (busy || !next || next === currentProfileName) return;
				setBusy(true);
				try {
					const r = await api("/api/undo/instances", "POST", { switch: { profile: next } });
					if (r && r.ok) { location.reload(); return; }
					setMsgOk(false);
					const code = r && r.error && r.error.code ? String(r.error.code) : "";
					setMsg(code === "busy" ? t("instance.busy") : t("err", { msg: (r && (r.error && (r.error.message || r.error))) || "unknown" }));
				} finally {
					setBusy(false);
				}
			};
			// W62：实例下拉与连端口。无 instances 配置时也给“本机”一条，入口永远可见。
			const effInst = instances && instances.effective ? instances.effective : null;
			const effName = effInst && effInst.name ? String(effInst.name) : "";
			const localLabel = (effName ? effName + " · " : "") + t("panel.instance.current") + (effInst && effInst.profile ? " · " + effInst.profile : "");
			const instList = instances && Array.isArray(instances.instances) ? instances.instances : [];
			const effInstName = effInst && effInst.name ? String(effInst.name) : "";
			const effInstEntry = instList.find((x) => x.name === effInstName) || null;
			const homeMismatch = !!(effInstEntry && effInstEntry.homeMismatch); // 端口被别的实例占用：配置 home 与实际 home 不一致
			const selValue = remote ? "remote" : (effInstName && instList.some((x) => x.name === effInstName) ? "inst:" + effInstName : "local");
			const proxyProbe = (url, token) => fetch("/api/undo/instances/proxy", {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ url, token, path: "/api/undo/status", method: "GET" })
			}).then((r) => r.json()).then((j) => (j && j.ok ? j.data : null)).catch(() => null);
			const onInstanceChange = async (e) => {
				const v = e.target.value;
				if (v === "remote") return;
				saveRemote(null);
				setRemote(null);
				const r = v === "local"
					? await api("/api/undo/instances", "POST", { reset: true })
					: await api("/api/undo/instances", "POST", { instance: v.slice(5) });
				if (r && !r.ok) setMsg(t("err", { msg: (r.error && (r.error.message || r.error)) || "unknown" }));
				await load();
			};
			const connectRemote = async () => {
				const url = String(remoteUrl || "").trim();
				if (!url) { setRemoteMsg(t("panel.instance.fail", { msg: "url" })); return; }
				const st = await proxyProbe(url, remoteToken);
				if (st && st.ok) {
					const next = { url, token: remoteToken };
					saveRemote(next);
					setRemote(next);
					setRemoteOpen(false);
					setRemoteMsg(null);
					await load();
				} else {
					setRemoteMsg(t("panel.instance.fail", { msg: "unreachable" }));
				}
			};
			const saveInstance = async () => {
				const name = String(instName || "").trim();
				const home = String(instHome || "").trim();
				if (!name || !home) { setInstMsg(t("panel.instance.addFail", { msg: "name/home" })); return; }
				const r = await api("/api/undo/instances", "POST", { upsert: { name, home } });
				if (r && r.ok) {
					setInstName(""); setInstHome(""); setInstMsg(t("panel.instance.added"));
					await load();
				} else {
					setInstMsg(t("panel.instance.addFail", { msg: (r && r.error && (r.error.message || r.error)) || "unknown" }));
				}
			};
			const removeInstance = async (name) => {
				if (!window.confirm(t("panel.instance.confirmRemove", { name }))) return;
				const r = await api("/api/undo/instances", "POST", { remove: name });
				if (r && !r.ok) setMsg(t("err", { msg: (r.error && (r.error.message || r.error)) || "unknown" }));
				await load();
			};
			return (0, react_jsx_runtime.jsx)(UndoLayer, { children: (0, react_jsx_runtime.jsx)("div", {
				className: styles.overlay,
				"data-undo-panel": true,
				onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); },
				children: (0, react_jsx_runtime.jsx)("div", {
					className: styles.panel,
					children: [
						(0, react_jsx_runtime.jsx)("div", {
							className: styles.head,
							children: [
								(0, react_jsx_runtime.jsx)(CameraIcon, { size: 16 }),
								(0, react_jsx_runtime.jsx)("span", { className: styles.title, children: t("panel.title") }),
								profile !== null && (0, react_jsx_runtime.jsx)("span", { className: styles.subtitle, title: t("panel.profile", { profile }), children: t("panel.profile", { profile }) }),
								profileSrc !== null && (0, react_jsx_runtime.jsx)("span", { className: styles.subtitle, children: t("panel.profile.src", { src: profileSrc }) }),
								(0, react_jsx_runtime.jsx)("select", {
									className: styles.keyInput, style: { width: 168, height: 24 }, "data-undo-instance": "1",
									title: t("panel.instance"), "aria-label": t("panel.instance"),
									value: selValue, onChange: onInstanceChange,
									children: [
										(0, react_jsx_runtime.jsx)("option", { value: "local", children: localLabel }),
										...(remote ? [(0, react_jsx_runtime.jsx)("option", { value: "remote", children: t("panel.instance.remote") + " · " + remote.url })] : []),
										...instList.map((x) => (0, react_jsx_runtime.jsx)("option", { value: "inst:" + x.name, title: x.homeMismatch ? t("instance.mismatch.hint") : "", children: x.name + (x.profile ? " · " + x.profile : "") + (x.homeMismatch ? " ⚠" : "") }, "inst:" + x.name))
									]
								}),
								(0, react_jsx_runtime.jsx)("button", {
									type: "button", className: styles.btn, title: t("panel.instance.connect"), "aria-label": t("panel.instance.connect"),
									onClick: () => setRemoteOpen((v) => !v), children: "🌐"
								}),
								(0, react_jsx_runtime.jsx)("button", {
									type: "button", className: styles.btn, title: t("panel.instance.add"), "aria-label": t("panel.instance.add"),
									onClick: () => setInstOpen((v) => !v), children: "+"
								}),
								(0, react_jsx_runtime.jsx)("button", {
									type: "button", className: styles.close, "aria-label": t("panel.close"),
									onClick: onClose, children: "×"
								})
							]
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: styles.flow,
							"data-undo-flow": true,
							children: [
								(0, react_jsx_runtime.jsx)("span", { className: styles.flowStep, children: t("panel.instance") }),
								(0, react_jsx_runtime.jsx)("span", { className: styles.flowName, title: (instanceNameNow || effName || t("panel.instance.current")) + (statusPort !== null ? " :" + statusPort : ""), children: (instanceNameNow || effName || t("panel.instance.current")) + (statusPort !== null ? " :" + statusPort : "") }),
								homeMismatch && (0, react_jsx_runtime.jsx)("span", { className: styles.badge + " " + styles.warn, title: t("instance.mismatch.hint"), children: "⚠ " + t("instance.mismatch") }),
								(0, react_jsx_runtime.jsx)("span", { className: styles.flowArrow, children: "→" }),
								(0, react_jsx_runtime.jsx)("span", { className: styles.flowStep, children: t("flow.profile") }),
								(0, react_jsx_runtime.jsx)("span", { className: styles.seg, role: "group", "aria-label": t("flow.profile"), children: profileNames.map((p) => (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: styles.segBtn + (p === currentProfileName ? " " + styles.segOn : ""),
									"aria-pressed": p === currentProfileName,
									"data-undo-profile": p,
									disabled: busy || !!remote,
									title: t("flow.switchProfile", { profile: p }),
									onClick: () => switchProfile(p),
									children: p
								}, "seg:" + p)) }),
								(0, react_jsx_runtime.jsx)("span", { className: styles.flowArrow, children: "→" }),
								(0, react_jsx_runtime.jsx)("span", { className: styles.flowStep, children: t("flow.store") }),
								(0, react_jsx_runtime.jsx)("span", { className: styles.storeChip + (storeShared ? " " + styles.warn : ""), title: storeRoot || "", children: storeScopeLabel })
							]
						}),
						instOpen && (0, react_jsx_runtime.jsx)("div", {
							className: styles.remoteBar, "data-undo-instance-manage": true,
							children: [
								...instList.map((x) => (0, react_jsx_runtime.jsxs)("span", { className: styles.stat, title: x.home, children: [
									x.name + (x.port ? " :" + x.port : "") + " · " + x.home,
									(0, react_jsx_runtime.jsx)("span", { className: styles.badge + (x.reachable ? "" : " " + styles.errc), children: x.reachable ? t("online") : t("offline") }),
									x.reachable && x.hasApi === false && (0, react_jsx_runtime.jsx)("span", { className: styles.badge + " " + styles.warn, title: t("apiOld.hint"), children: t("apiOld") }),
									x.homeMismatch && (0, react_jsx_runtime.jsx)("span", { className: styles.badge + " " + styles.warn, title: t("instance.mismatch.hint"), children: "⚠ " + t("instance.mismatch") }),
									(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.rowbtn, onClick: () => removeInstance(x.name), children: "×" })
								] }, "mgr:" + x.name)),
								(0, react_jsx_runtime.jsx)("input", { type: "text", className: styles.keyInput, style: { width: 110 }, placeholder: t("panel.instance.name"), value: instName, onChange: (e) => setInstName(e.target.value) }),
								(0, react_jsx_runtime.jsx)("input", { type: "text", className: styles.keyInput, style: { width: 280 }, placeholder: t("panel.instance.home"), value: instHome, onChange: (e) => setInstHome(e.target.value) }),
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn + " " + styles.save, onClick: saveInstance, children: t("panel.instance.save") }),
								instMsg && (0, react_jsx_runtime.jsx)("span", { className: styles.err, children: instMsg }),
								(0, react_jsx_runtime.jsx)("span", { className: styles.hint, children: t("panel.instance.settingsFile") + ": " + (instances && instances.settingsFile ? instances.settingsFile : "—") })
							]
						}),
						remoteOpen && (0, react_jsx_runtime.jsx)("div", {
							className: styles.remoteBar, "data-undo-remote": true,
							children: [
								(0, react_jsx_runtime.jsx)("input", { type: "text", className: styles.keyInput, style: { width: 260 }, placeholder: t("panel.instance.url"), value: remoteUrl, onChange: (e) => setRemoteUrl(e.target.value), "aria-label": t("panel.instance.url") }),
								(0, react_jsx_runtime.jsx)("input", { type: "password", className: styles.keyInput, style: { width: 160 }, placeholder: t("panel.instance.token"), value: remoteToken, onChange: (e) => setRemoteToken(e.target.value), "aria-label": t("panel.instance.token"), "data-undo-key-input": "1" }),
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn + " " + styles.save, onClick: connectRemote, children: t("panel.instance.connect") }),
								remote && (0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn, onClick: () => { saveRemote(null); setRemote(null); setRemoteMsg(null); load(); }, children: t("panel.instance.disconnect") }),
								remoteMsg && (0, react_jsx_runtime.jsx)("span", { className: styles.err, children: remoteMsg })
							]
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: styles.toolbar,
							children: [
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.save, disabled: busy, onClick: saveNow, children: t("panel.save") }),
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn + " " + styles.undo, disabled: busy, onClick: () => act("undo", "/api/undo/undo"), children: t("undo") }),
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn + " " + styles.redo, disabled: busy, onClick: () => act("redo", "/api/undo/redo"), children: t("redo") }),
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn, disabled: busy, onClick: load, children: t("panel.refresh") }),
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn, disabled: busy, onClick: cleanupNow, children: t("panel.cleanup") }),
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn, disabled: busy, onClick: exportNow, children: t("panel.export") }),
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn, disabled: busy, onClick: importNow, children: t("panel.import") }),
								(0, react_jsx_runtime.jsx)("input", { type: "password", className: styles.keyInput, style: { width: 140 }, placeholder: t("export.pass"), value: pass, onChange: (e) => setPass(e.target.value), "aria-label": t("export.pass"), title: t("export.pass"), "data-undo-key-input": "1" }),
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn + " " + styles.safe, disabled: busy, onClick: toggleSafeMode, children: t("safe.mode") })
							]
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: styles.statusBar,
							"data-undo-status": true,
							children: [
								(0, react_jsx_runtime.jsx)("span", { className: styles.stat, children: t("panel.instance") + ": " + (instanceNameNow || effName || t("panel.instance.current")) + (statusPort !== null ? " · " + t("status.port") + " " + statusPort : "") }),
								homeMismatch && (0, react_jsx_runtime.jsx)("span", { className: styles.stat + " " + styles.warn, title: t("instance.mismatch.hint"), children: "⚠ " + t("instance.mismatch") }),
								(0, react_jsx_runtime.jsx)("span", { className: styles.stat, children: t("status.profile") + ": " + (profile || "—") + (profileSrc ? " · " + profileSrc : "") }),
								!storeShared && (0, react_jsx_runtime.jsx)("span", { className: styles.stat, title: storeRoot, style: { maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }, children: t("status.scope") + ": " + storeScopeLabel }),
								storeShared && (0, react_jsx_runtime.jsx)("span", { className: styles.stat + " " + styles.warn, title: t("status.shared.hint"), children: t("status.shared") + (profilesSeen.size > 1 ? " · " + profilesSeen.size : "") }),
								(0, react_jsx_runtime.jsx)("span", { className: styles.stat, title: (instances && instances.settingsFile) || "", style: { maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: t("panel.instance.settingsFile") + ": " + ((instances && instances.settingsFile) ? String(instances.settingsFile) : "—") }),
								(0, react_jsx_runtime.jsx)("span", { className: styles.stat, children: t("status.sensitive") + ": " + t(settings && settings.sensitiveMode === "keep" ? "status.sensitive.keep" : "status.sensitive.redact") }),
								(0, react_jsx_runtime.jsx)("span", { className: styles.stat, children: t("status.size") + ": " + all.length + " · " + fmtBytes(libBytes) }),
								(0, react_jsx_runtime.jsx)("span", { className: styles.stat, children: t("status.last") + ": " + (lastAt ? new Date(lastAt).toLocaleString() : "—") }),
								(0, react_jsx_runtime.jsx)("span", { className: styles.stat + (safeModeNow ? " " + styles.warn : ""), children: t("safe.mode") + ": " + (safeModeNow === null ? "—" : t(safeModeNow ? "status.on" : "status.off")) })
							]
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: styles.searchBar,
							children: [
								(0, react_jsx_runtime.jsx)("input", {
									type: "search", className: styles.keyInput, style: { width: 200 },
									placeholder: t("panel.search"), value: query, "data-undo-search": "1",
									"aria-label": t("panel.search"),
									onChange: (e) => { setQuery(e.target.value); setPage(0); }
								}),
								query !== "" && (0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn, onClick: () => { setQuery(""); setPage(0); }, children: t("panel.search.clear") }),
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn, disabled: busy, onClick: () => setView(view === "cards" ? "table" : "cards"), children: t(view === "cards" ? "panel.view.table" : "panel.view.cards") }),
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn + (showShared ? " " + styles.chipOn : ""), "aria-pressed": showShared, "data-undo-shared-toggle": "1", title: t("panel.showShared.hint") + (counts ? " · web " + (counts.web || 0) + " / desktop " + (counts.desktop || 0) + " / " + t("unknownProfile") + " " + (counts.unknown || 0) : ""), onClick: () => { setShowShared((v) => !v); setPage(0); }, children: t("panel.showShared") }),
								selected.length > 0 && (0, react_jsx_runtime.jsxs)("span", { className: styles.batchBar, children: [
									(0, react_jsx_runtime.jsx)("span", { className: styles.stat, children: t("panel.selected", { n: selected.length }) }),
									(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn + " " + styles.undo, disabled: busy, onClick: deleteSelected, children: t("panel.batch.delete") }),
									(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn, onClick: () => setSelected([]), children: t("panel.batch.clear") })
								] }),
								pageCount > 1 && (0, react_jsx_runtime.jsxs)("span", { className: styles.batchBar, children: [
									(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn, disabled: pageSafe <= 0, onClick: () => setPage(pageSafe - 1), children: "‹" }),
									(0, react_jsx_runtime.jsx)("span", { className: styles.stat, children: (pageSafe + 1) + " / " + pageCount }),
									(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn, disabled: pageSafe >= pageCount - 1, onClick: () => setPage(pageSafe + 1), children: "›" })
								] }),
								(0, react_jsx_runtime.jsx)("div", {
									className: styles.chipBar,
									role: "group",
									"aria-label": t("panel.filter.kind"),
									children: KIND_FILTERS.map((k) => (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: styles.chip + (kindFilter === k ? " " + styles.chipOn : ""),
										"aria-pressed": kindFilter === k,
										"data-undo-kind-filter": k,
										onClick: () => { setKindFilter(k); setPage(0); },
										children: k === "all" ? t("filter.all") : k === "pre-restore" ? t("filter.preRestore") : k === "other" ? t("filter.other") : t(k === "manual" ? "type.manual" : "type.auto")
									}, "kind:" + k))
								})
							]
						}),
						diff !== null && (0, react_jsx_runtime.jsx)(DiffOverlay, {
							diff, t, collapsed: diffCollapsed,
							onToggleFile: (name) => setDiffCollapsed((cur) => { const next = { ...cur }; if (next[name]) delete next[name]; else next[name] = true; return next; }),
							onClose: () => setDiff(null),
							onRetry: () => showDiff({ id: diff.id })
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: styles.tbody,
							children: snaps === null ? (0, react_jsx_runtime.jsx)("div", { className: styles.state, children: [
								(0, react_jsx_runtime.jsx)("span", { className: styles.stateIcon, children: "⏳" }),
								(0, react_jsx_runtime.jsx)("span", { className: styles.stateText, children: t("panel.loading") }),
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.statePrimary, disabled: busy, onClick: load, children: t("panel.refresh") })
							] })
								: loadError !== null ? (0, react_jsx_runtime.jsx)("div", { className: styles.state, children: [
									(0, react_jsx_runtime.jsx)("span", { className: styles.stateIcon, children: "⚠" }),
									(0, react_jsx_runtime.jsx)("span", { className: styles.stateText, children: t("err", { msg: loadError }) }),
									(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.statePrimary, disabled: busy, onClick: load, children: t("panel.retry") })
								] })
								: visible.length === 0 ? (0, react_jsx_runtime.jsx)("div", { className: styles.state, children: [
									(0, react_jsx_runtime.jsx)("span", { className: styles.stateIcon, children: query !== "" ? "🔍" : "🗂" }),
									(0, react_jsx_runtime.jsx)("span", { className: styles.stateText, children: query !== "" ? t("panel.noMatch") : t("panel.empty") }),
									(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.statePrimary, disabled: busy, onClick: query !== "" ? () => { setQuery(""); setPage(0); } : saveNow, children: query !== "" ? t("panel.search.clear") : t("panel.save") })
								] })
									: view === "table" ? (0, react_jsx_runtime.jsx)("table", {
										className: styles.table,
										children: [
											(0, react_jsx_runtime.jsx)("thead", {
												children: (0, react_jsx_runtime.jsx)("tr", {
													children: [
														(0, react_jsx_runtime.jsx)("th", { children: t("panel.col.time") }),
														(0, react_jsx_runtime.jsx)("th", { children: t("panel.col.kind") }),
														(0, react_jsx_runtime.jsx)("th", { children: t("panel.col.profile") }),
														(0, react_jsx_runtime.jsx)("th", { children: t("panel.col.reason") }),
														(0, react_jsx_runtime.jsx)("th", { children: t("panel.col.files") }),
														(0, react_jsx_runtime.jsx)("th", { children: t("panel.col.loc") }),
														(0, react_jsx_runtime.jsx)("th", { children: t("panel.col.ops") })
													]
												})
											}),
											(0, react_jsx_runtime.jsx)("tbody", {
												children: shown.map((s) => (0, react_jsx_runtime.jsxs)("tr", {
													children: [
														(0, react_jsx_runtime.jsx)("td", { className: styles.time, children: new Date(s.time).toLocaleString() }),
														(0, react_jsx_runtime.jsx)("td", { className: styles.kind, children: t(KIND_KEYS[s.kind] || s.kind) }),
														(0, react_jsx_runtime.jsx)("td", { children: s.profileMatch === null ? (0, react_jsx_runtime.jsx)("span", { className: styles.profileBadge + " " + styles.profileUnknown, title: t("unknownProfile"), children: t("unknownProfile") }) : (0, react_jsx_runtime.jsx)("span", { className: styles.profileBadge + (s.profile ? (profile && s.profile !== profile ? " " + styles.profileOther : "") : " " + styles.profileUnknown), title: s.profile || t("unknownProfile"), children: s.profile || "—" }) }),
														(0, react_jsx_runtime.jsx)("td", { className: styles.reason, title: s.reason || "", children: s.reason || "—" }),
														(0, react_jsx_runtime.jsx)("td", { children: String(s.files ? s.files.length : 0) }),
														(0, react_jsx_runtime.jsx)("td", { className: styles.loc, children: t(LOC_KEYS[s.location] || s.location) }),
														(0, react_jsx_runtime.jsxs)("td", {
															children: [
																(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.rowbtn, disabled: busy, onClick: () => showDiff(s), children: t("panel.op.diff") }),
																(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.rowbtn, disabled: busy, onClick: () => restoreOne(s), children: t("panel.op.restore") }),
																(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.rowbtn + " " + styles.errc, disabled: busy, onClick: () => deleteOne(s), children: t("panel.op.delete") })
															]
														})
													]
												}, s.id))
											})
										]
									})
									: (0, react_jsx_runtime.jsx)("div", { className: styles.cards, children: shownGroups.map((g) => (0, react_jsx_runtime.jsxs)("div", {
										className: styles.group,
										children: [
											(0, react_jsx_runtime.jsx)("div", { className: styles.groupHead, children: t("panel.group." + g.key) + " (" + g.items.length + ")" }),
											g.items.map((s) => (0, react_jsx_runtime.jsxs)("div", {
												className: styles.card,
												"data-undo-card": s.id,
												tabIndex: 0,
												onKeyDown: (e) => onCardKey(e, s),
												children: [
													(0, react_jsx_runtime.jsx)("input", { type: "checkbox", checked: selected.indexOf(s.id) >= 0, onChange: () => toggleSel(s.id), "aria-label": t("panel.select") }),
													(0, react_jsx_runtime.jsx)("span", { className: styles.cardTime, children: new Date(s.time).toLocaleString() }),
													(0, react_jsx_runtime.jsx)("span", { className: styles.kind, children: t(KIND_KEYS[s.kind] || s.kind) }),
													(0, react_jsx_runtime.jsx)("span", { className: styles.profileBadge + (s.profileMatch === null || !s.profile ? " " + styles.profileUnknown : (profile && s.profile !== profile ? " " + styles.profileOther : "")), title: s.profileMatch === null ? t("unknownProfile") : (s.profile || t("unknownProfile")), children: s.profileMatch === null || !s.profile ? t("unknownProfile") : s.profile }),
													(0, react_jsx_runtime.jsx)("span", { className: styles.cardReason, title: s.reason || "", children: s.reason || "—" }),
													(0, react_jsx_runtime.jsx)("span", { className: styles.loc, children: String(s.files ? s.files.length : 0) + " " + t("panel.col.files") }),
													(0, react_jsx_runtime.jsxs)("span", {
														className: styles.cardOps,
														children: [
															(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.rowbtn, disabled: busy, onClick: () => showDiff(s), children: t("panel.op.diff") }),
															(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.rowbtn, disabled: busy, onClick: () => restoreOne(s), children: t("panel.op.restore") }),
															(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.rowbtn + " " + styles.errc, disabled: busy, onClick: () => deleteOne(s), children: t("panel.op.delete") })
														]
													})
												]
											}, s.id))
										]
									})) })
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: styles.foot,
							children: [
								bootAlert && (0, react_jsx_runtime.jsx)("span", { className: styles.msg + " " + styles.err, children: [
									t("boot.alert"),
									bootAlert.crashReason === "session-corrupt" && t("boot.crash.session"),
									bootAlert.crashReason === "bundle-check" && t("boot.crash.bundle"),
									bootAlert.crashReason === "patch-tree" && t("boot.crash.patch"),
									bootAlert.lastGoodSnapshotId && (0, react_jsx_runtime.jsx)("button", {
										type: "button", className: styles.rowbtn + " " + styles.okc, style: { marginLeft: 6 },
										onClick: () => act("restore", "/api/undo/restore", { id: bootAlert.lastGoodSnapshotId }),
										children: t("boot.rollback")
									})
								] }),
								msg !== null && (0, react_jsx_runtime.jsx)("span", {
									className: styles.msg + " " + (msgOk ? styles.ok : styles.err),
									children: msg
								}),
								snaps !== null && (0, react_jsx_runtime.jsx)("span", { className: styles.hint, children: t("panel.updated", { n: snaps.length }) })
							]
						})
					]
				})
			}) });
		}
		//#endregion
		//#region KeyBindRow (settings.general.item)
		/** Custom shortcut settings row: capture combos for undo/redo. */
		function KeyBindRow({ t }) {
			const [keys, setKeysState] = (0, react.useState)(loadKeys);
			const [capturing, setCapturing] = (0, react.useState)(null);
			const capture = (which) => (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (e.key === "Backspace" || e.key === "Delete") {
					const next = { ...keys, [which]: null };
					setKeysState(next);
					saveKeys(next);
					setCapturing(null);
					return;
				}
				if (["Control", "Alt", "Shift", "Meta", "Escape", "Tab", "CapsLock"].indexOf(e.key) >= 0) return;
				const next = { ...keys, [which]: { ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey, key: e.key } };
				setKeysState(next);
				saveKeys(next);
				setCapturing(null);
			};
			const bind = (which) => {
				const cur = keys[which];
				return (0, react_jsx_runtime.jsx)("input", {
					type: "text",
					readOnly: true,
					className: styles.keyInput,
					"data-undo-key-input": "1",
					placeholder: cur ? formatKey(cur) : t("keys.none"),
					value: capturing === which ? t("keys.press") : (cur ? formatKey(cur) : ""),
					onFocus: () => { setCapturing(which); },
					onBlur: () => { setCapturing(null); },
					onKeyDown: capture(which),
					"aria-label": t(which === "undo" ? "keys.undo" : "keys.redo")
				});
			};
			return (0, react_jsx_runtime.jsx)("div", {
				className: styles.row,
				"data-undo-keys": true,
				children: [
					(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("keys.undo") }),
					bind("undo"),
					(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("keys.redo") }),
					bind("redo"),
					(0, react_jsx_runtime.jsx)("span", { className: styles.hint, children: t("keys.hint") })
				]
			});
		}
		//#endregion
		//#region UndoMainPage + UndoSettingsSection (own sidebar section)
		/** Full snapshot settings page shown in its own sidebar section. */
		function UndoMainPage(props) {
			const t = (props && typeof props.t === "function") ? props.t : ((k) => (zh && zh[k]) || k);
			const [s, setS] = (0, react.useState)(null);
			const [msg, setMsg] = (0, react.useState)(null);
			const [msgOk, setMsgOk] = (0, react.useState)(true);
			const [settingsFile, setSettingsFile] = (0, react.useState)("");
			const [instInfo, setInstInfo] = (0, react.useState)(null);
			const [copied, setCopied] = (0, react.useState)(false);
			const copyText = async (text) => {
				const value = String(text || "");
				try {
					if (navigator.clipboard && navigator.clipboard.writeText) {
						await navigator.clipboard.writeText(value);
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
						return;
					}
				} catch (e) { /* 剪贴板被拒时退回 prompt */ }
				try { window.prompt(t("settings.copy"), value); } catch (e2) { /* noop */ }
			};
			const load = (0, react.useCallback)(async () => {
				const r = await api("/api/undo/settings");
				if (r && r.ok) { setS(r.settings); setSettingsFile(r.settingsFile || ""); }
				const ii = await api("/api/undo/instances");
				if (ii && ii.ok) setInstInfo(ii);
			}, []);
			(0, react.useEffect)(() => { load(); }, [load]);
			// 另一个入口改了同一个 settings 文件时，切回本页立刻重读。
			(0, react.useEffect)(() => {
				const onFocus = () => { load(); };
				window.addEventListener("focus", onFocus);
				return () => window.removeEventListener("focus", onFocus);
			}, [load]);
			const set = (k, v) => setS((prev) => (prev ? { ...prev, [k]: v } : prev));
			const pickDir = async (k) => {
				const r = await api("/api/undo/pick-dir", "POST", {});
				if (r && r.ok && r.path) set(k, r.path);
			};
			const save = async () => {
				const r = await api("/api/undo/settings", "POST", s);
				setMsgOk(!!(r && r.ok));
				setMsg(r && r.ok ? t("settings.saved") : t("settings.error", { msg: (r && (r.error && (r.error.message || r.error))) || "unknown" }));
				if (r && r.ok) await load();
			};
			return s === null ? (0, react_jsx_runtime.jsx)("div", { className: styles.row, children: t("busy") })
				: (0, react_jsx_runtime.jsx)("div", {
					"data-undo-settings-page": true,
					style: { display: "flex", flexDirection: "column", gap: 12, maxWidth: 680, padding: "4px 2px" },
					children: [
						(0, react_jsx_runtime.jsx)("div", { className: styles.meta, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.metaLabel, children: t("settings.currentInstance") }),
							(0, react_jsx_runtime.jsx)("span", { children: ((instInfo && instInfo.effective && instInfo.effective.name) || "—") + (instInfo && instInfo.effective && instInfo.effective.port ? " :" + instInfo.effective.port : "") }),
							(0, react_jsx_runtime.jsx)("span", { className: styles.metaLabel, children: t("settings.currentProfile") }),
							(0, react_jsx_runtime.jsx)("span", { children: (instInfo && instInfo.effective && instInfo.effective.profile) || (instInfo && instInfo.currentProfile) || "—" })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.meta, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.metaLabel, children: t("panel.instance.store") }),
							(0, react_jsx_runtime.jsx)("span", { title: (instInfo && instInfo.effective && instInfo.effective.storeRoot) || "", style: { maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: (instInfo && instInfo.effective && instInfo.effective.storeRoot) || "—" })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.meta, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.metaLabel, children: t("panel.instance.settingsFile") }),
							(0, react_jsx_runtime.jsx)("span", { title: settingsFile || "", style: { maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: settingsFile || "—" }),
							(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.copyBtn, title: t("settings.copy"), "aria-label": t("settings.copy"), onClick: () => copyText(settingsFile), children: copied ? t("settings.copied") : t("settings.copy") })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("label", { className: styles.keyLabel, children: [
								(0, react_jsx_runtime.jsx)("input", { type: "checkbox", checked: !!s.autoEnabled, onChange: (e) => set("autoEnabled", e.target.checked) }),
								" " + t("settings.auto")
							] })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("settings.debounce") }),
							(0, react_jsx_runtime.jsx)("input", { type: "number", className: styles.keyInput + " " + styles.num, value: s.watchDebounceMs, onChange: (e) => set("watchDebounceMs", Number(e.target.value)) })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("settings.keep") }),
							(0, react_jsx_runtime.jsx)("input", { type: "number", className: styles.keyInput + " " + styles.num, value: s.keepAuto, onChange: (e) => set("keepAuto", Number(e.target.value)) })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("settings.keepPre") }),
							(0, react_jsx_runtime.jsx)("input", { type: "number", className: styles.keyInput + " " + styles.num, value: s.keepPre, onChange: (e) => set("keepPre", Number(e.target.value)) })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("settings.headerMode") }),
							(0, react_jsx_runtime.jsx)("select", {
								className: styles.keyInput,
								value: s.headerMode || "auto",
								onChange: (e) => set("headerMode", e.target.value),
								children: [
									(0, react_jsx_runtime.jsx)("option", { value: "auto", children: t("settings.headerMode.auto") }),
									(0, react_jsx_runtime.jsx)("option", { value: "full", children: t("settings.headerMode.full") }),
									(0, react_jsx_runtime.jsx)("option", { value: "compact", children: t("settings.headerMode.compact") })
								]
							})
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("label", { className: styles.keyLabel, children: [
								(0, react_jsx_runtime.jsx)("input", { type: "checkbox", checked: !!s.autoCleanup, onChange: (e) => set("autoCleanup", e.target.checked) }),
								" " + t("settings.autoCleanup")
							] })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.hint, children: t("settings.cleanupNote", { keepAuto: s.keepAuto, keepPre: s.keepPre }) })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("settings.sensitive") }),
							(0, react_jsx_runtime.jsx)("select", {
								className: styles.keyInput,
								value: s.sensitiveMode || "redact",
								onChange: (e) => set("sensitiveMode", e.target.value),
								children: [
									(0, react_jsx_runtime.jsx)("option", { value: "redact", children: t("settings.sensitive.redact") }),
									(0, react_jsx_runtime.jsx)("option", { value: "keep", children: t("settings.sensitive.keep") })
								]
							})
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("settings.pluginDirs") }),
							(0, react_jsx_runtime.jsx)("input", {
								type: "text",
								className: styles.keyInput + " " + styles.dir,
								value: Array.isArray(s.pluginDirs) ? s.pluginDirs.join(", ") : "",
								onChange: (e) => set("pluginDirs", e.target.value)
							})
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("settings.manualDir") }),
							(0, react_jsx_runtime.jsx)("input", { type: "text", className: styles.keyInput + " " + styles.dir, value: s.manualDir, onChange: (e) => set("manualDir", e.target.value) }),
							(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.browseBtn, title: t("settings.browse"), "aria-label": t("settings.browse"), onClick: () => pickDir("manualDir"), children: "📁" })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("settings.autoDir") }),
							(0, react_jsx_runtime.jsx)("input", { type: "text", className: styles.keyInput + " " + styles.dir, value: s.autoDir, onChange: (e) => set("autoDir", e.target.value) }),
							(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.browseBtn, title: t("settings.browse"), "aria-label": t("settings.browse"), onClick: () => pickDir("autoDir"), children: "📁" })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("label", { className: styles.keyLabel, children: [
								(0, react_jsx_runtime.jsx)("input", { type: "checkbox", checked: s.createDesktopShortcut !== false, onChange: (e) => set("createDesktopShortcut", e.target.checked), "data-undo-key-input": "1" }),
								" " + t("settings.desktop")
							] })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.hint, children: t("settings.desktopInfo") + ": " + (s.desktopDir || "") })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("label", { className: styles.keyLabel, children: [
								(0, react_jsx_runtime.jsx)("input", { type: "checkbox", checked: !!s.scheduledSnapshotEnabled, onChange: (e) => set("scheduledSnapshotEnabled", e.target.checked), "data-undo-key-input": "1" }),
								" " + t("settings.schedule.enabled")
							] })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("settings.schedule.ms") }),
							(0, react_jsx_runtime.jsx)("input", { type: "number", className: styles.keyInput + " " + styles.num, min: 1, value: Math.round((s.scheduledSnapshotMs || 0) / 60000), onChange: (e) => set("scheduledSnapshotMs", Math.max(1, Math.round(Number(e.target.value) || 0)) * 60000), "data-undo-key-input": "1" }),
							(0, react_jsx_runtime.jsx)("span", { className: styles.hint, children: t("settings.schedule.hint") })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("settings.workspaceDirs") }),
							(0, react_jsx_runtime.jsx)("input", { type: "text", className: styles.keyInput + " " + styles.dir, value: (Array.isArray(s.workspaceDirs) ? s.workspaceDirs.join(", ") : ""), onChange: (e) => set("workspaceDirs", e.target.value), "data-undo-key-input": "1" }),
							(0, react_jsx_runtime.jsx)("span", { className: styles.hint, children: t("settings.workspaceDirs.hint") })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("label", { className: styles.keyLabel, children: [
								(0, react_jsx_runtime.jsx)("input", { type: "checkbox", checked: s.bootHealthEnabled !== false, onChange: (e) => set("bootHealthEnabled", e.target.checked), "data-undo-key-input": "1" }),
								" " + t("settings.bootHealth")
							] })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("label", { className: styles.keyLabel, children: [
								(0, react_jsx_runtime.jsx)("input", { type: "checkbox", checked: s.upgradeGuardEnabled !== false, onChange: (e) => set("upgradeGuardEnabled", e.target.checked), "data-undo-key-input": "1" }),
								" " + t("settings.upgradeGuard")
							] })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("settings.autoSafeMode") }),
							(0, react_jsx_runtime.jsx)("input", { type: "number", className: styles.keyInput + " " + styles.num, min: 0, value: Number(s.autoSafeModeAfterFails ?? 2), onChange: (e) => set("autoSafeModeAfterFails", Math.max(0, Number(e.target.value) || 0)), "data-undo-key-input": "1" })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("span", { className: styles.keyLabel, children: t("settings.guardMode") }),
							(0, react_jsx_runtime.jsx)("select", {
								className: styles.keyInput,
								value: s.guardAutoSafeMode || "ask",
								onChange: (e) => set("guardAutoSafeMode", e.target.value),
								children: [
									(0, react_jsx_runtime.jsx)("option", { value: "ask", children: t("settings.guardAsk") }),
									(0, react_jsx_runtime.jsx)("option", { value: "on", children: t("settings.guardOn") }),
									(0, react_jsx_runtime.jsx)("option", { value: "off", children: t("settings.guardOff") })
								]
							})
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("label", { className: styles.keyLabel, children: [
								(0, react_jsx_runtime.jsx)("input", { type: "checkbox", checked: !!s.guardShortcutEnabled, onChange: (e) => set("guardShortcutEnabled", e.target.checked), "data-undo-key-input": "1" }),
								" " + t("settings.guardShortcut")
							] })
						] }),
						(0, react_jsx_runtime.jsx)("div", { className: styles.pair, children: [
							(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.save, onClick: save, children: t("settings.save") }),
							(0, react_jsx_runtime.jsx)("button", { type: "button", className: styles.btn, onClick: load, children: t("panel.instance.refresh") }),
							msg !== null && (0, react_jsx_runtime.jsx)("span", { className: styles.msg + " " + (msgOk ? styles.ok : styles.err), children: msg })
						] })
					]
				});
		}
		/** Sidebar section shell: renders the settings page registered under it. */
		function UndoSettingsSection({ t, renderSlot }) {
			return (0, react_jsx_runtime.jsx)("div", {
				"data-undo-settings-section": true,
				style: { display: "flex", flexDirection: "column", gap: 8 },
				children: renderSlot("settings.undo.item", {})
			});
		}
		/** Bundle configuration panel registered in plugins.bundle.config */
		function UndoBundleConfig(props) {
			const tr = (props && typeof props.t === "function") ? props.t : ((k) => (zh && zh[k]) || k);
			const [panelOpen, setPanelOpen] = (0, react.useState)(false);
			return (0, react_jsx_runtime.jsxs)("div", {
				"data-undo-bundle-config": true,
				style: { display: "flex", flexDirection: "column", gap: 12, padding: "4px 0" },
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
						children: [
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: styles.btn + " " + styles.save,
								style: { height: 28, padding: "0 12px", fontWeight: 600 },
								onClick: () => setPanelOpen((prev) => !prev),
								children: (panelOpen ? "✖ " + tr("panel.close") : "📂 " + tr("panel.title"))
							})
						]
					}),
					panelOpen && (0, react_jsx_runtime.jsx)(SnapshotPanel, { t: tr, onClose: () => setPanelOpen(false) }),
					(0, react_jsx_runtime.jsx)(UndoMainPage, { t: tr })
				]
			});
		}
		//#endregion
		//#region client entry
		const inject = ["locale", "slots"];
		function apply(ctx) {
			// rc8 兼容盖子（2026-08-20）：客户端服务调用逐项 try/catch 降级，
			// 单项失败只 console.warn 跳过，不拖垮整个 client（WebUI 半区保命）。
			// W87（issue #54）：失败要可见。每个注册点失败记标签，apply 末尾把汇总写到
			// document.documentElement.dataset.undoClient，现场一条查询就能区分「没执行」与「注册被吞」。
			const failures = [];
			const warn = (label, error) => {
				failures.push(label);
				try { console.warn("[dsh-undo-savepoint] " + label + " degraded: " + String((error && error.message) || error)); } catch (e) { /* noop */ }
			};
			const safe = (label, fn) => {
				try { return fn(); } catch (error) { warn(label, error); return void 0; }
			};
			// 服务探测：0.2.2 线若改了客户端服务名或注入时机，这里留下明确的一条，
			// 不让整片 UI 无声消失（issue #54 的候选 B）。
			try {
				for (const svc of ["slots", "locale"]) {
					if (!ctx || !ctx[svc]) failures.push("missing-service:" + svc);
				}
				if (failures.length) console.error("[dsh-undo-savepoint] client degraded: " + failures.join(", "));
				document.documentElement.dataset.undoClient = failures.length ? "degraded:" + failures.join(",") : "booting";
			} catch (e) { /* noop */ }
			let t = (key) => key; // locale 兜底：绑定失败时原样返回 key，页面不崩
			safe("locale.register", () => ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-undo-savepoint: dictionaries"));
			safe("locale.bind", () => { t = ctx.locale.bind(NS); });
			let panelOpen = false;
			const panelHandlers = new Set();
			const setPanelOpen = (v) => { panelOpen = v; for (const h of panelHandlers) h(v); };
			// Undo/redo/snapshot buttons in the conversation header (核心入口，最优先保留)
			safe("slots:conversation.session.header.actions", () => ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "undo-buttons",
				order: 10,
				locale: NS,
				inject: () => ({
					onOpenPanel: () => setPanelOpen(true)
				})
			}, (props) => {
				// Subscribe to the panel-open flag so the header button can open the shared panel.
				const [open, setOpen] = (0, react.useState)(panelOpen);
				(0, react.useEffect)(() => {
					panelHandlers.add(setOpen);
					return () => { panelHandlers.delete(setOpen); };
				}, []);
				return (0, react_jsx_runtime.jsxs)(react.Fragment, {
					children: [
						(0, react_jsx_runtime.jsx)(UndoHeader, { t: props.t, onOpenPanel: props.onOpenPanel }),
						open && (0, react_jsx_runtime.jsx)(SnapshotPanel, { t: props.t, onClose: () => setPanelOpen(false) })
					]
				});
			})));
			// Custom shortcut settings row (General settings)
			safe("slots:settings.general.item", () => ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "undo-keys",
				order: 30,
				locale: NS
			}, KeyBindRow)));
			// Snapshot settings: own sidebar section (rc8 设置面板改动风险点；失败只跳过整页)
			let sectionOk = false;
			safe("slots:settings.section", () => {
				ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "dsh-undo",
					order: 30,
					label: () => t("settings.nav"),
					locale: NS,
					children: { "settings.undo.item": { kind: "list", scope: "root" } }
				}, UndoSettingsSection));
				sectionOk = true;
			});
			// 设置页内容仅在页面槽注册成功后注入，避免孤儿槽
			if (sectionOk) {
				safe("slots:settings.undo.item", () => ctx.slots.inject("settings.undo.item", () => ctx.slots.register({
					name: "settings.undo.item",
					id: "main",
					order: 0,
					locale: NS
				}, UndoMainPage)));
			}
			// Bundle configuration panel in Plugins page detail view
			safe("slots:plugins.bundle.config", () => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: "dsh-undo-savepoint",
				locale: NS
			}, UndoBundleConfig)));
			// Global keyboard shortcuts
			safe("keyboard", () => ctx.effect(() => {
				const onKeyDown = (e) => {
					if (e.defaultPrevented || e.repeat) return;
					const target = e.target;
					if (target && target.dataset && target.dataset.undoKeyInput === "1") return; // the settings inputs themselves
					const keys = loadKeys();
					if (keys.undo && keyEventMatches(e, keys.undo)) {
						e.preventDefault();
						api("/api/undo/undo", "POST").then((r) => { publishResult(r, "undo"); maybeReload(r, "undo"); });
						return;
					}
					if (keys.redo && keyEventMatches(e, keys.redo)) {
						e.preventDefault();
						api("/api/undo/redo", "POST").then((r) => { publishResult(r, "redo"); maybeReload(r, "redo"); });
					}
				};
				window.addEventListener("keydown", onKeyDown, true);
				return () => window.removeEventListener("keydown", onKeyDown, true);
			}, "dsh-undo-savepoint: keyboard"));
			// W87：装配汇总。ready 表示五个注册点全部执行，degraded 列出失败标签。
			try {
				if (failures.length === 0) {
					document.documentElement.dataset.undoClient = "ready";
					console.info("[dsh-undo-savepoint] client ready (5/5 slots)");
				} else {
					document.documentElement.dataset.undoClient = "degraded:" + failures.join(",");
					console.error("[dsh-undo-savepoint] client degraded: " + failures.length + " failed (" + failures.join(", ") + ")");
				}
			} catch (e) { /* noop */ }
		}
		//#endregion
		exports.UndoHeader = UndoHeader;
		exports.SnapshotPanel = SnapshotPanel;
		exports.KeyBindRow = KeyBindRow;
		exports.UndoMainPage = UndoMainPage;
		exports.UndoSettingsSection = UndoSettingsSection;
		exports.UndoBundleConfig = UndoBundleConfig;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
