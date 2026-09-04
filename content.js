/* =========================================================
   FAAST Tote Progress Extension v3.0
   Extensión Chrome para TC57 - Recepción de Totes en MFAC
   
   Flujo:
   1. Operario carga CSV (shipmentItemList.csv) una vez al inicio
   2. La extensión parsea el CSV y agrupa por tote (Scannable ID)
   3. Al escanear un tote en "Scan Container" → auto-detecta unidades
   4. Cada scan en FNSKU/UPC/LPN → avanza la barra
   5. Botón "Finalizar Tote" → resumen de pendientes
   
   CSV esperado: columnas "Scannable ID", "FN SKU", "Quantity"
   ========================================================= */

(function () {
  'use strict';

  // =========================================================
  // CONFIG
  // =========================================================
  var CONFIG = {
    POLL_INTERVAL: 500,
    SCAN_DEBOUNCE: 300,
    STORAGE_KEY: 'toteProgress_',
    CSV_STORAGE_KEY: 'toteCSVData',
    REPORT_STORAGE_KEY: 'toteReportCache',
    VERSION: '4.0'
  };

  // =========================================================
  // STATE
  // =========================================================
  var state = {
    active: false,
    csvLoaded: false,
    toteData: {},         // { toteId: { totalQty, fnskus: [{fnsku, qty}] } }
    toteId: '',
    expectedUnits: 0,
    receivedUnits: 0,
    pendingToteId: '',
    shipmentIndex: {},    // { shipmentId: { totes: [toteId,...], fnskus: [{fnsku, qty, toteId}] } }
    reportInProgress: false,
    scanHistory: [],
    fnskuDetail: {},      // { fnsku: { expected, received } }
    lastFnskuValue: '',
    lastContainerValue: ''
  };

  // =========================================================
  // HELPERS
  // =========================================================
  function getTimestamp() {
    var d = new Date();
    return d.getHours().toString().padStart(2, '0') + ':' +
           d.getMinutes().toString().padStart(2, '0') + ':' +
           d.getSeconds().toString().padStart(2, '0');
  }

  function saveProgress() {
    try {
      var data = {
        toteId: state.toteId,
        expectedUnits: state.expectedUnits,
        receivedUnits: state.receivedUnits,
        scanHistory: state.scanHistory,
        fnskuDetail: state.fnskuDetail,
        timestamp: Date.now()
      };
      localStorage.setItem(CONFIG.STORAGE_KEY + state.toteId, JSON.stringify(data));
    } catch (e) { /* silently fail */ }
  }

  function loadProgress(toteId) {
    try {
      var saved = localStorage.getItem(CONFIG.STORAGE_KEY + toteId);
      if (saved) {
        var data = JSON.parse(saved);
        if (Date.now() - data.timestamp < 86400000) return data;
      }
    } catch (e) { /* silently fail */ }
    return null;
  }

  function clearProgress(toteId) {
    try { localStorage.removeItem(CONFIG.STORAGE_KEY + toteId); } catch (e) {}
  }

  function saveCSVData() {
    try {
      localStorage.setItem(CONFIG.CSV_STORAGE_KEY, JSON.stringify({
        toteData: state.toteData,
        shipmentIndex: state.shipmentIndex,
        timestamp: Date.now()
      }));
    } catch (e) {}
  }

  function loadCSVData() {
    try {
      var saved = localStorage.getItem(CONFIG.CSV_STORAGE_KEY);
      if (saved) {
        var data = JSON.parse(saved);
        // CSV válido por 24h
        if (Date.now() - data.timestamp < 86400000) {
          state.toteData = data.toteData;
          state.shipmentIndex = data.shipmentIndex || {};
          state.csvLoaded = true;
          return true;
        }
      }
    } catch (e) {}
    return false;
  }

  // =========================================================
  // CSV PARSER
  // =========================================================
  function parseCSV(csvText) {
    var lines = csvText.split('\n');
    if (lines.length < 2) return {};

    // Parsear header
    var header = parseCSVLine(lines[0]);
    var colScannable = -1, colFnsku = -1, colQty = -1, colTransferId = -1;

    for (var h = 0; h < header.length; h++) {
      var col = header[h].trim().toLowerCase();
      if (col === 'scannable id') colScannable = h;
      else if (col === 'fn sku' || col === 'fnsku') colFnsku = h;
      else if (col === 'quantity') colQty = h;
      else if (col === 'transfer request id') colTransferId = h;
    }

    if (colScannable === -1 || colQty === -1) {
      alert('⚠️ CSV no válido.\n\nColumnas requeridas:\n- "Scannable ID"\n- "Quantity"\n\nColumnas encontradas:\n' + header.join(', '));
      return {};
    }

    // Parsear filas y agrupar por tote
    var toteData = {};
    var shipmentIndex = {};
    for (var i = 1; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;

      var fields = parseCSVLine(line);
      var toteId = (fields[colScannable] || '').trim();
      var fnsku = colFnsku >= 0 ? (fields[colFnsku] || '').trim() : '';
      var qty = parseInt(fields[colQty]) || 0;
      var transferId = colTransferId >= 0 ? (fields[colTransferId] || '').trim() : '';

      // Solo contar como totes los IDs que empiezan por "ts"
      if (!toteId || qty === 0 || !toteId.startsWith('ts')) continue;

      if (!toteData[toteId]) {
        toteData[toteId] = { totalQty: 0, fnskus: [], transferId: transferId };
      }

      toteData[toteId].totalQty += qty;

      if (fnsku) {
        // Buscar si ya existe este FNSKU para este tote
        var existing = null;
        for (var f = 0; f < toteData[toteId].fnskus.length; f++) {
          if (toteData[toteId].fnskus[f].fnsku === fnsku) {
            existing = toteData[toteId].fnskus[f];
            break;
          }
        }
        if (existing) {
          existing.qty += qty;
        } else {
          toteData[toteId].fnskus.push({ fnsku: fnsku, qty: qty });
        }
      }

      // Indexar por shipment/transfer
      if (transferId) {
        if (!shipmentIndex[transferId]) {
          shipmentIndex[transferId] = { totes: [], fnskus: [], totalQty: 0 };
        }
        var si = shipmentIndex[transferId];
        if (si.totes.indexOf(toteId) === -1) si.totes.push(toteId);
        si.totalQty += qty;
        // Agregar FNSKU al índice del shipment
        var existingSI = null;
        for (var s = 0; s < si.fnskus.length; s++) {
          if (si.fnskus[s].fnsku === fnsku && si.fnskus[s].toteId === toteId) {
            existingSI = si.fnskus[s]; break;
          }
        }
        if (existingSI) { existingSI.qty += qty; }
        else if (fnsku) { si.fnskus.push({ fnsku: fnsku, qty: qty, toteId: toteId }); }
      }
    }

    // Guardar shipmentIndex en state
    state.shipmentIndex = shipmentIndex;

    return toteData;
  }

  function parseCSVLine(line) {
    var fields = [];
    var current = '';
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if (c === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += c;
      }
    }
    fields.push(current.trim());
    return fields;
  }

  // =========================================================
  // DETECTAR CAMPOS DE FAAST
  // =========================================================
  function findContainerInput() {
    var inputs = document.querySelectorAll('input[type="text"]');
    for (var i = 0; i < inputs.length; i++) {
      var ph = (inputs[i].placeholder || '').toLowerCase();
      if (ph.indexOf('tote') !== -1 || ph.indexOf('case') !== -1 || ph.indexOf('container') !== -1) {
        return inputs[i];
      }
    }
    var labels = document.querySelectorAll('label, span, div');
    for (var j = 0; j < labels.length; j++) {
      var text = (labels[j].textContent || '').trim().toLowerCase();
      if (text === 'scan container') {
        var parent = labels[j].closest('.row') || labels[j].parentElement;
        if (parent) {
          var inp = parent.querySelector('input[type="text"]');
          if (inp) return inp;
        }
      }
    }
    return null;
  }

  function findFnskuInput() {
    var inputs = document.querySelectorAll('input[type="text"]');
    for (var i = 0; i < inputs.length; i++) {
      var ph = (inputs[i].placeholder || '').toLowerCase();
      var id = (inputs[i].id || '').toLowerCase();
      if (ph.indexOf('fnsku') !== -1 || ph.indexOf('upc') !== -1 || ph.indexOf('lpn') !== -1 ||
          id.indexOf('fnsku') !== -1 || id.indexOf('upc') !== -1 || id.indexOf('lpn') !== -1) {
        return inputs[i];
      }
    }
    var labels = document.querySelectorAll('label, span, div');
    for (var j = 0; j < labels.length; j++) {
      var text = (labels[j].textContent || '').trim();
      if (text.indexOf('FNSKU') !== -1 || text.indexOf('UPC') !== -1 || text.indexOf('LPN') !== -1) {
        var parent = labels[j].closest('.row') || labels[j].parentElement;
        if (parent) {
          var inp = parent.querySelector('input[type="text"]');
          if (inp) return inp;
        }
      }
    }
    return null;
  }

  function findInsertionPoint() {
    var containerInput = findContainerInput();
    if (containerInput) {
      var row = containerInput.closest('.row') || containerInput.closest('div[class*="row"]') || containerInput.parentElement.parentElement;
      return row;
    }
    return document.getElementById('main-container');
  }

  // =========================================================
  // UI: CREAR ELEMENTOS
  // =========================================================
  function createCSVLoader() {
    var panel = document.createElement('div');
    panel.id = 'tote-csv-loader';
    panel.style.cssText = 'padding:10px 16px;background:#1a2332;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;';
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
        '<div style="font-size:13px;font-weight:700;color:#ff9900;">📄 Cargar Lista de Totes</div>' +
        '<div id="csv-status" style="font-size:11px;color:#8899aa;"></div>' +
        '<div id="tote-minimize-btn" style="cursor:pointer;font-size:16px;color:#8899aa;margin-left:8px;" title="Minimizar">▼</div>' +
      '</div>' +
      '<div id="tote-csv-content">' +
      '<div style="font-size:11px;color:#8899aa;margin-bottom:8px;">Sube el archivo <strong style="color:#ffb84d;">shipmentItemList.csv</strong></div>' +
      '<div style="display:flex;gap:8px;align-items:center;">' +
        '<label for="csv-file-input" style="flex:1;padding:12px;background:rgba(255,255,255,0.06);border:2px dashed rgba(255,153,0,0.5);border-radius:8px;text-align:center;cursor:pointer;font-size:13px;font-weight:600;color:#ff9900;transition:all 0.15s;">' +
          '📁 SELECCIONAR CSV' +
          '<input type="file" id="csv-file-input" accept=".csv,.txt" style="display:none;">' +
        '</label>' +
        '<button id="btn-report-inbound" style="display:none;padding:12px 16px;background:linear-gradient(135deg,#0066cc,#0052a3);color:#fff;font-weight:700;border:none;border-radius:8px;cursor:pointer;font-size:13px;white-space:nowrap;" title="Genera Excel con estado de recepción por tote">📥 REPORTE INBOUND</button>' +
        '<button id="btn-monitor-live" style="display:none;padding:12px 16px;background:linear-gradient(135deg,#00875a,#006644);color:#fff;font-weight:700;border:none;border-radius:8px;cursor:pointer;font-size:13px;white-space:nowrap;" title="Monitor en tiempo real de recepción">📊 MONITOR LIVE</button>' +
      '</div>' +
      '<div id="csv-tote-count" style="display:none;margin-top:8px;padding:6px 10px;background:rgba(54,179,126,0.15);border:1px solid rgba(54,179,126,0.4);border-radius:6px;text-align:center;font-size:12px;font-weight:600;color:#57d9a3;"></div>' +
      '</div>';
    return panel;
  }

  function createSetupPanel() {
    var panel = document.createElement('div');
    panel.id = 'tote-setup-panel';
    panel.style.cssText = 'display:none;padding:10px 16px;background:#1a2332;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;border-top:1px solid rgba(255,255,255,0.1);';
    panel.innerHTML =
      '<h3 style="margin:0 0 6px 0;color:#ff9900;font-size:15px;">📦 Tote Detectado</h3>' +
      '<div style="font-size:12px;color:#8899aa;margin-bottom:4px;">Tote: <span id="setup-tote-id" style="color:#ffb84d;font-family:monospace;"></span></div>' +
      '<div id="setup-auto-info" style="display:none;padding:8px 12px;background:rgba(54,179,126,0.15);border:1px solid rgba(54,179,126,0.4);border-radius:8px;margin-bottom:8px;font-size:13px;color:#57d9a3;text-align:center;"></div>' +
      '<div id="setup-manual-input" style="display:none;">' +
        '<div style="font-size:13px;margin-bottom:8px;color:#ff7452;">⚠️ Tote no encontrado en el CSV. Introduce unidades manualmente:</div>' +
        '<div style="display:flex;gap:8px;align-items:center;">' +
          '<input type="number" id="input-expected-units" min="1" max="9999" placeholder="Uds." inputmode="numeric" style="flex:1;padding:12px;font-size:18px;font-weight:700;font-family:monospace;border:2px solid #ff9900;border-radius:8px;background:rgba(255,255,255,0.06);color:#fff;text-align:center;-webkit-appearance:none;-moz-appearance:textfield;" />' +
        '</div>' +
      '</div>' +
      '<div style="margin-top:10px;">' +
        '<button id="btn-start-tote" style="width:100%;padding:12px;background:linear-gradient(135deg,#36b37e,#2d9a6b);color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;text-transform:uppercase;">▶ INICIAR RECEPCIÓN</button>' +
      '</div>';
    return panel;
  }

  function createProgressWidget() {
    var widget = document.createElement('div');
    widget.id = 'tote-progress-container';
    widget.style.cssText = 'display:none;padding:10px 16px;background:#1a2332;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;position:relative;border-top:1px solid rgba(255,255,255,0.1);';
    widget.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
        '<div style="font-size:15px;font-weight:700;color:#ff9900;display:flex;align-items:center;gap:6px;"><span>📦</span> Progreso Tote</div>' +
        '<div id="tote-id-display" style="font-size:11px;color:#8899aa;font-family:monospace;background:rgba(255,255,255,0.08);padding:2px 8px;border-radius:4px;"></div>' +
      '</div>' +
      // Counters
      '<div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:10px;">' +
        '<div style="flex:1;text-align:center;padding:8px 4px;background:rgba(255,255,255,0.06);border-radius:8px;border:1px solid rgba(255,255,255,0.1);">' +
          '<div id="count-received" style="font-size:26px;font-weight:800;font-family:monospace;color:#36b37e;line-height:1.1;">0</div>' +
          '<div style="font-size:9px;color:#8899aa;text-transform:uppercase;letter-spacing:0.5px;margin-top:2px;">Recibidas</div>' +
        '</div>' +
        '<div style="flex:1;text-align:center;padding:8px 4px;background:rgba(255,255,255,0.06);border-radius:8px;border:1px solid rgba(255,255,255,0.1);">' +
          '<div id="count-expected" style="font-size:26px;font-weight:800;font-family:monospace;color:#ff9900;line-height:1.1;">0</div>' +
          '<div style="font-size:9px;color:#8899aa;text-transform:uppercase;letter-spacing:0.5px;margin-top:2px;">Esperadas</div>' +
        '</div>' +
        '<div style="flex:1;text-align:center;padding:8px 4px;background:rgba(255,255,255,0.06);border-radius:8px;border:1px solid rgba(255,255,255,0.1);">' +
          '<div id="count-pending" style="font-size:26px;font-weight:800;font-family:monospace;color:#ff5630;line-height:1.1;">0</div>' +
          '<div style="font-size:9px;color:#8899aa;text-transform:uppercase;letter-spacing:0.5px;margin-top:2px;">Pendientes</div>' +
        '</div>' +
      '</div>' +
      // Progress bar
      '<div id="tote-progress-bar-wrapper" style="width:100%;height:28px;background:rgba(255,255,255,0.1);border-radius:14px;overflow:hidden;position:relative;margin-bottom:8px;border:1px solid rgba(255,255,255,0.15);">' +
        '<div id="tote-progress-bar-fill" style="height:100%;background:linear-gradient(90deg,#ff9900,#ffb84d);border-radius:14px;transition:width 0.4s cubic-bezier(0.22,1,0.36,1);width:0%;position:relative;"></div>' +
        '<div id="tote-progress-percentage" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:13px;font-weight:800;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.5);z-index:2;">0%</div>' +
      '</div>' +
      // FNSKU detail table
      '<div id="tote-fnsku-detail" style="display:none;margin-bottom:8px;max-height:120px;overflow-y:auto;background:rgba(255,255,255,0.04);border-radius:6px;padding:4px;"></div>' +
      '<div id="tote-fnsku-toggle" style="text-align:center;font-size:11px;color:#667788;cursor:pointer;padding:2px;margin-bottom:6px;">▼ Ver detalle por FNSKU</div>' +
      // Last scan
      '<div id="tote-last-scan" style="font-size:11px;color:#8899aa;text-align:center;margin-bottom:10px;min-height:16px;">Esperando primer escaneo...</div>' +
      // Buttons
      '<div style="display:flex;gap:8px;">' +
        '<button id="btn-finalizar-tote" style="flex:1;padding:12px 8px;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;text-transform:uppercase;letter-spacing:0.5px;background:linear-gradient(135deg,#ff9900,#e88a00);color:#1a2332;">✅ FINALIZAR TOTE</button>' +
        '<button id="btn-reset-tote" style="padding:12px 16px;border:1px solid rgba(255,255,255,0.15);border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;background:rgba(255,255,255,0.1);color:#8899aa;">🔄</button>' +
      '</div>';
    return widget;
  }

  function createSummaryOverlay() {
    var overlay = document.createElement('div');
    overlay.id = 'tote-summary-overlay';
    overlay.style.cssText = 'display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.75);z-index:99999;justify-content:center;align-items:center;padding:16px;box-sizing:border-box;';
    overlay.innerHTML =
      '<div style="background:#1a2332;border-radius:14px;border:2px solid #ff9900;padding:20px;max-width:400px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.5);color:#fff;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif;max-height:90vh;overflow-y:auto;">' +
        '<h2 style="margin:0 0 4px 0;font-size:18px;color:#ff9900;text-align:center;">📋 Resumen del Tote</h2>' +
        '<div id="summary-tote-id" style="text-align:center;font-size:12px;color:#8899aa;font-family:monospace;margin-bottom:14px;"></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">' +
          '<div style="text-align:center;padding:12px 8px;background:rgba(255,255,255,0.06);border-radius:8px;border:1px solid rgba(255,255,255,0.1);">' +
            '<div id="summary-received" style="font-size:28px;font-weight:800;font-family:monospace;color:#36b37e;">0</div>' +
            '<div style="font-size:10px;color:#8899aa;text-transform:uppercase;margin-top:4px;">Recibidas</div>' +
          '</div>' +
          '<div style="text-align:center;padding:12px 8px;background:rgba(255,255,255,0.06);border-radius:8px;border:1px solid rgba(255,255,255,0.1);">' +
            '<div id="summary-pending" style="font-size:28px;font-weight:800;font-family:monospace;color:#ff5630;">0</div>' +
            '<div style="font-size:10px;color:#8899aa;text-transform:uppercase;margin-top:4px;">Pendientes</div>' +
          '</div>' +
          '<div style="text-align:center;padding:12px 8px;background:rgba(255,255,255,0.06);border-radius:8px;border:1px solid rgba(255,255,255,0.1);">' +
            '<div id="summary-expected" style="font-size:28px;font-weight:800;font-family:monospace;color:#ff9900;">0</div>' +
            '<div style="font-size:10px;color:#8899aa;text-transform:uppercase;margin-top:4px;">Esperadas</div>' +
          '</div>' +
          '<div style="text-align:center;padding:12px 8px;background:rgba(255,255,255,0.06);border-radius:8px;border:1px solid rgba(255,255,255,0.1);">' +
            '<div id="summary-percentage" style="font-size:28px;font-weight:800;font-family:monospace;color:#4c9aff;">0%</div>' +
            '<div style="font-size:10px;color:#8899aa;text-transform:uppercase;margin-top:4px;">Completado</div>' +
          '</div>' +
        '</div>' +
        // Detalle por FNSKU en resumen
        '<div id="summary-fnsku-detail" style="margin-bottom:14px;"></div>' +
        '<div id="summary-alert" style="padding:10px 12px;border-radius:8px;text-align:center;font-size:13px;font-weight:600;margin-bottom:14px;"></div>' +
        '<button id="btn-cerrar-resumen" style="width:100%;padding:14px;background:linear-gradient(135deg,#ff9900,#e88a00);color:#1a2332;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;text-transform:uppercase;letter-spacing:0.5px;">CERRAR Y SIGUIENTE TOTE</button>' +
      '</div>';
    return overlay;
  }

  // =========================================================
  // UI: UPDATE PROGRESS
  // =========================================================
  function updateProgressUI() {
    var received = state.receivedUnits;
    var expected = state.expectedUnits;
    var pending = Math.max(0, expected - received);
    var pct = expected > 0 ? Math.min(100, Math.round((received / expected) * 100)) : 0;

    var el = function(id) { return document.getElementById(id); };
    
    if (el('count-received')) el('count-received').textContent = received;
    if (el('count-expected')) el('count-expected').textContent = expected;
    if (el('count-pending')) el('count-pending').textContent = pending;

    var barFill = el('tote-progress-bar-fill');
    if (barFill) {
      barFill.style.width = pct + '%';
      barFill.style.background = pct >= 100 
        ? 'linear-gradient(90deg,#36b37e,#57d9a3)' 
        : 'linear-gradient(90deg,#ff9900,#ffb84d)';
    }
    if (el('tote-progress-percentage')) el('tote-progress-percentage').textContent = pct + '%';

    // Flash animation
    var container = el('tote-progress-container');
    if (container) {
      container.style.boxShadow = '0 4px 16px rgba(54,179,126,0.6),inset 0 0 20px rgba(54,179,126,0.1)';
      setTimeout(function() {
        container.style.boxShadow = '0 4px 16px rgba(0,0,0,0.3)';
      }, 400);
    }

    // Update FNSKU detail table
    updateFnskuDetail();
  }

  function updateFnskuDetail() {
    var detailDiv = document.getElementById('tote-fnsku-detail');
    if (!detailDiv) return;
    
    var toteInfo = state.toteData[state.toteId];
    if (!toteInfo || !toteInfo.fnskus || toteInfo.fnskus.length === 0) return;

    var html = '<table style="width:100%;border-collapse:collapse;font-size:11px;">' +
      '<tr style="color:#8899aa;"><th style="text-align:left;padding:3px 6px;">FNSKU</th><th style="text-align:center;padding:3px 4px;">Esp.</th><th style="text-align:center;padding:3px 4px;">Rec.</th><th style="text-align:center;padding:3px 4px;">Pend.</th></tr>';

    var fnskus = toteInfo.fnskus;
    for (var i = 0; i < fnskus.length; i++) {
      var f = fnskus[i];
      var rec = (state.fnskuDetail[f.fnsku] && state.fnskuDetail[f.fnsku].received) || 0;
      var pend = Math.max(0, f.qty - rec);
      var rowColor = pend === 0 ? '#36b37e' : (rec > 0 ? '#ffb84d' : '#ff5630');
      var bg = pend === 0 ? 'rgba(54,179,126,0.08)' : 'transparent';
      
      html += '<tr style="border-top:1px solid rgba(255,255,255,0.05);background:' + bg + ';">' +
        '<td style="padding:3px 6px;font-family:monospace;color:' + rowColor + ';">' + f.fnsku + '</td>' +
        '<td style="text-align:center;padding:3px 4px;color:#ff9900;">' + f.qty + '</td>' +
        '<td style="text-align:center;padding:3px 4px;color:#36b37e;">' + rec + '</td>' +
        '<td style="text-align:center;padding:3px 4px;color:' + (pend > 0 ? '#ff5630' : '#36b37e') + ';">' + pend + '</td>' +
      '</tr>';
    }
    html += '</table>';
    detailDiv.innerHTML = html;
  }

  // =========================================================
  // LOGIC: START TOTE
  // =========================================================
  function startTote(toteId, expectedUnits, previousState) {
    state.active = true;
    state.toteId = toteId;
    state.expectedUnits = expectedUnits;

    if (previousState) {
      state.receivedUnits = previousState.receivedUnits;
      state.scanHistory = previousState.scanHistory || [];
      state.fnskuDetail = previousState.fnskuDetail || {};
    } else {
      state.receivedUnits = 0;
      state.scanHistory = [];
      state.fnskuDetail = {};
      // Initialize fnskuDetail from CSV
      var toteInfo = state.toteData[toteId];
      if (toteInfo && toteInfo.fnskus) {
        for (var i = 0; i < toteInfo.fnskus.length; i++) {
          state.fnskuDetail[toteInfo.fnskus[i].fnsku] = {
            expected: toteInfo.fnskus[i].qty,
            received: 0
          };
        }
      }
    }

    // Hide setup, show progress
    var setupPanel = document.getElementById('tote-setup-panel');
    var progressContainer = document.getElementById('tote-progress-container');
    var csvLoader = document.getElementById('tote-csv-loader');

    if (setupPanel) setupPanel.style.display = 'none';
    if (progressContainer) progressContainer.style.display = 'block';
    if (csvLoader) csvLoader.style.display = 'none';

    if (document.getElementById('tote-id-display')) {
      document.getElementById('tote-id-display').textContent = toteId;
    }

    updateProgressUI();
    saveProgress();
  }

  // =========================================================
  // LOGIC: REGISTER SCAN
  // =========================================================
  function registerScan(fnskuCode) {
    if (!state.active || !fnskuCode || fnskuCode.trim() === '') return;

    var code = fnskuCode.trim();
    state.receivedUnits++;

    // Update FNSKU-level tracking
    if (!state.fnskuDetail[code]) {
      state.fnskuDetail[code] = { expected: 0, received: 0 };
    }
    state.fnskuDetail[code].received++;

    state.scanHistory.unshift({
      code: code,
      time: getTimestamp() + ' (#' + state.receivedUnits + ')'
    });

    updateProgressUI();

    // Update last scan text
    var lastScan = document.getElementById('tote-last-scan');
    if (lastScan) {
      lastScan.innerHTML = 'Último: <span style="color:#ffb84d;font-family:monospace;font-weight:600;">' + code + '</span> a las ' + getTimestamp();
    }

    saveProgress();
  }

  // =========================================================
  // LOGIC: FINALIZE TOTE
  // =========================================================
  function finalizarTote() {
    var received = state.receivedUnits;
    var expected = state.expectedUnits;
    var pending = Math.max(0, expected - received);
    var pct = expected > 0 ? Math.round((received / expected) * 100) : 0;

    var el = function(id) { return document.getElementById(id); };

    if (el('summary-received')) el('summary-received').textContent = received;
    if (el('summary-pending')) el('summary-pending').textContent = pending;
    if (el('summary-expected')) el('summary-expected').textContent = expected;
    if (el('summary-percentage')) el('summary-percentage').textContent = pct + '%';
    if (el('summary-tote-id')) el('summary-tote-id').textContent = 'Tote: ' + state.toteId;

    // FNSKU detail in summary
    var detailDiv = el('summary-fnsku-detail');
    if (detailDiv) {
      var toteInfo = state.toteData[state.toteId];
      if (toteInfo && toteInfo.fnskus && toteInfo.fnskus.length > 0) {
        var html = '<div style="font-size:11px;color:#8899aa;margin-bottom:6px;text-align:center;">DETALLE POR FNSKU</div>' +
          '<table style="width:100%;border-collapse:collapse;font-size:11px;">' +
          '<tr style="color:#8899aa;"><th style="text-align:left;padding:3px 6px;">FNSKU</th><th style="text-align:center;padding:3px 4px;">Esp.</th><th style="text-align:center;padding:3px 4px;">Rec.</th><th style="text-align:center;padding:3px 4px;">Pend.</th></tr>';

        for (var i = 0; i < toteInfo.fnskus.length; i++) {
          var f = toteInfo.fnskus[i];
          var rec = (state.fnskuDetail[f.fnsku] && state.fnskuDetail[f.fnsku].received) || 0;
          var pend2 = Math.max(0, f.qty - rec);
          var color = pend2 === 0 ? '#36b37e' : '#ff5630';
          var bg = pend2 === 0 ? 'rgba(54,179,126,0.08)' : 'rgba(255,86,48,0.08)';
          
          html += '<tr style="border-top:1px solid rgba(255,255,255,0.05);background:' + bg + ';">' +
            '<td style="padding:4px 6px;font-family:monospace;color:' + color + ';">' + f.fnsku + '</td>' +
            '<td style="text-align:center;padding:4px;color:#ff9900;">' + f.qty + '</td>' +
            '<td style="text-align:center;padding:4px;color:#36b37e;">' + rec + '</td>' +
            '<td style="text-align:center;padding:4px;color:' + color + ';font-weight:700;">' + pend2 + '</td>' +
          '</tr>';
        }

        // Add any extra FNSKUs scanned that weren't in CSV
        var extraFnskus = Object.keys(state.fnskuDetail);
        for (var j = 0; j < extraFnskus.length; j++) {
          var fk = extraFnskus[j];
          if (state.fnskuDetail[fk].expected === 0 && state.fnskuDetail[fk].received > 0) {
            html += '<tr style="border-top:1px solid rgba(255,255,255,0.05);background:rgba(255,184,77,0.08);">' +
              '<td style="padding:4px 6px;font-family:monospace;color:#ffb84d;">' + fk + ' ⚠️</td>' +
              '<td style="text-align:center;padding:4px;color:#8899aa;">?</td>' +
              '<td style="text-align:center;padding:4px;color:#36b37e;">' + state.fnskuDetail[fk].received + '</td>' +
              '<td style="text-align:center;padding:4px;color:#ffb84d;">N/A</td>' +
            '</tr>';
          }
        }

        html += '</table>';
        detailDiv.innerHTML = html;
        detailDiv.style.cssText = 'margin-bottom:14px;max-height:200px;overflow-y:auto;background:rgba(255,255,255,0.04);border-radius:8px;padding:8px;';
      } else {
        detailDiv.innerHTML = '';
      }
    }

    // Alert
    var alertDiv = el('summary-alert');
    if (alertDiv) {
      if (pending > 0) {
        alertDiv.style.cssText = 'padding:10px 12px;border-radius:8px;text-align:center;font-size:13px;font-weight:600;margin-bottom:14px;background:rgba(255,86,48,0.15);border:1px solid rgba(255,86,48,0.4);color:#ff7452;';
        alertDiv.innerHTML = '⚠️ Quedan <strong>' + pending + ' unidades</strong> pendientes por recibir';
      } else if (received > expected) {
        alertDiv.style.cssText = 'padding:10px 12px;border-radius:8px;text-align:center;font-size:13px;font-weight:600;margin-bottom:14px;background:rgba(255,184,77,0.15);border:1px solid rgba(255,184,77,0.4);color:#ffb84d;';
        alertDiv.innerHTML = '⚠️ Se han recibido <strong>' + (received - expected) + ' unidades de más</strong> vs lo esperado';
      } else {
        alertDiv.style.cssText = 'padding:10px 12px;border-radius:8px;text-align:center;font-size:13px;font-weight:600;margin-bottom:14px;background:rgba(54,179,126,0.15);border:1px solid rgba(54,179,126,0.4);color:#57d9a3;';
        alertDiv.innerHTML = '✅ ¡Tote completado al 100%! Todas las unidades recibidas';
      }
    }

    // Show overlay
    var overlay = el('tote-summary-overlay');
    if (overlay) overlay.style.display = 'flex';
  }

  function resetTote() {
    if (state.toteId) clearProgress(state.toteId);

    state.active = false;
    state.toteId = '';
    state.expectedUnits = 0;
    state.receivedUnits = 0;
    state.scanHistory = [];
    state.fnskuDetail = {};
    state.lastFnskuValue = '';
    state.lastContainerValue = '';

    var el = function(id) { return document.getElementById(id); };

    if (el('tote-progress-container')) el('tote-progress-container').style.display = 'none';
    if (el('tote-summary-overlay')) el('tote-summary-overlay').style.display = 'none';
    if (el('tote-setup-panel')) el('tote-setup-panel').style.display = 'none';
    if (el('tote-csv-loader') && state.csvLoaded) el('tote-csv-loader').style.display = 'none';
    else if (el('tote-csv-loader')) el('tote-csv-loader').style.display = 'block';

    if (el('tote-last-scan')) el('tote-last-scan').textContent = 'Esperando primer escaneo...';
    if (el('tote-fnsku-detail')) el('tote-fnsku-detail').innerHTML = '';
  }

  // =========================================================
  // SCAN DETECTION (polling inputs)
  // =========================================================
  var scanDebounceTimer = null;

  function watchInputs() {
    setInterval(function () {
      // Detect tote scanned in "Scan Container"
      if (!state.active) {
        var containerInput = findContainerInput();
        if (containerInput) {
          var containerVal = containerInput.value.trim();
          if (containerVal && containerVal !== state.lastContainerValue && containerVal.length > 3) {
            state.lastContainerValue = containerVal;
            onToteScanned(containerVal);
          }
        }
      }

      // Detect FNSKU scanned
      if (state.active) {
        var fnskuInput = findFnskuInput();
        if (fnskuInput) {
          var fnskuVal = fnskuInput.value.trim();
          if (fnskuVal && fnskuVal !== state.lastFnskuValue && fnskuVal.length > 3) {
            clearTimeout(scanDebounceTimer);
            var capturedVal = fnskuVal;
            scanDebounceTimer = setTimeout(function () {
              var currentVal = fnskuInput.value.trim();
              if (currentVal === capturedVal) {
                state.lastFnskuValue = capturedVal;
                registerScan(capturedVal);
                setTimeout(function () {
                  var newVal = fnskuInput.value.trim();
                  if (newVal === '' || newVal !== capturedVal) {
                    state.lastFnskuValue = newVal;
                  }
                }, 1000);
              }
            }, CONFIG.SCAN_DEBOUNCE);
          } else if (fnskuVal === '' && state.lastFnskuValue !== '') {
            state.lastFnskuValue = '';
          }
        }
      }
    }, CONFIG.POLL_INTERVAL);
  }

  function onToteScanned(toteId) {
    var previousState = loadProgress(toteId);
    var toteInfo = state.toteData[toteId];
    var autoDetected = !!(toteInfo && toteInfo.totalQty > 0);

    // Guardar el tote actual detectado (para re-evaluar si se carga el CSV después)
    state.pendingToteId = toteId;

    var setupPanel = document.getElementById('tote-setup-panel');
    if (!setupPanel) return;

    var setupToteId = document.getElementById('setup-tote-id');
    var autoInfo = document.getElementById('setup-auto-info');
    var manualInput = document.getElementById('setup-manual-input');
    var btnStart = document.getElementById('btn-start-tote');

    if (setupToteId) setupToteId.textContent = toteId;

    if (previousState) {
      // Resuming existing tote
      if (autoInfo) {
        autoInfo.style.display = 'block';
        autoInfo.innerHTML = '🔄 Progreso anterior encontrado: <strong>' + previousState.receivedUnits + ' / ' + previousState.expectedUnits + '</strong> recibidas';
      }
      if (manualInput) manualInput.style.display = 'none';
      if (btnStart) {
        btnStart.textContent = '▶ CONTINUAR RECEPCIÓN';
        btnStart.onclick = function () {
          startTote(toteId, previousState.expectedUnits, previousState);
        };
      }
    } else if (autoDetected) {
      // CSV match found
      var fnskuCount = toteInfo.fnskus ? toteInfo.fnskus.length : 0;
      if (autoInfo) {
        autoInfo.style.display = 'block';
        autoInfo.innerHTML = '✅ Tote encontrado en CSV: <strong>' + toteInfo.totalQty + ' unidades</strong> (' + fnskuCount + ' FNSKUs)';
      }
      if (manualInput) manualInput.style.display = 'none';
      if (btnStart) {
        btnStart.textContent = '▶ INICIAR RECEPCIÓN (' + toteInfo.totalQty + ' uds)';
        btnStart.onclick = function () {
          startTote(toteId, toteInfo.totalQty, null);
        };
      }
    } else {
      // Not found in CSV
      if (autoInfo) autoInfo.style.display = 'none';
      if (manualInput) manualInput.style.display = 'block';
      var inputExpected = document.getElementById('input-expected-units');
      if (inputExpected) {
        inputExpected.value = '';
        inputExpected.focus();
      }
      if (btnStart) {
        btnStart.textContent = '▶ INICIAR RECEPCIÓN';
        btnStart.onclick = function () {
          var expected = parseInt(document.getElementById('input-expected-units').value);
          if (!expected || expected < 1) {
            document.getElementById('input-expected-units').style.borderColor = '#ff5630';
            return;
          }
          startTote(toteId, expected, null);
        };
      }
    }

    setupPanel.style.display = 'block';
    // El CSV loader permanece visible (compacto arriba) para poder cargar el CSV en cualquier momento
  }

  // =========================================================
  // INIT
  // =========================================================
  function init() {
    var checkPage = setInterval(function () {
      var pageText = document.body.innerText || '';
      if (pageText.indexOf('Transfer Receive') !== -1 ||
          pageText.indexOf('Scan Container') !== -1 ||
          pageText.indexOf('Scan Tote') !== -1 ||
          window.location.href.indexOf('receiveProduct') !== -1 ||
          window.location.href.indexOf('/transfer/receive') !== -1 ||
          findContainerInput()) {
        clearInterval(checkPage);
        setTimeout(injectUI, 500); // Small delay to ensure page is fully rendered
      }
    }, 500);

    setTimeout(function () { clearInterval(checkPage); }, 30000);
  }

  function injectUI() {
    if (document.getElementById('tote-csv-loader')) return;

    // Create elements
    var csvLoader = createCSVLoader();
    var setupPanel = createSetupPanel();
    var progressWidget = createProgressWidget();
    var summaryOverlay = createSummaryOverlay();
    var reportModal = createReportModal();

    // Create fixed bottom container
    var bottomBar = document.createElement('div');
    bottomBar.id = 'tote-bottom-bar';
    bottomBar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:99998;background:#1a2332;border-top:2px solid #ff9900;box-shadow:0 -4px 16px rgba(0,0,0,0.4);max-height:60vh;overflow-y:auto;transition:max-height 0.3s ease;';

    bottomBar.appendChild(csvLoader);
    bottomBar.appendChild(setupPanel);
    bottomBar.appendChild(progressWidget);

    // Insert in DOM
    document.body.appendChild(bottomBar);
    document.body.appendChild(summaryOverlay);
    document.body.appendChild(reportModal);

    // Minimize/expand toggle
    var minimizeBtn = document.getElementById('tote-minimize-btn');
    if (minimizeBtn) {
      minimizeBtn.addEventListener('click', function () {
        var content = document.getElementById('tote-csv-content');
        if (content) {
          var isHidden = content.style.display === 'none';
          content.style.display = isHidden ? 'block' : 'none';
          minimizeBtn.textContent = isHidden ? '▼' : '▲';
          minimizeBtn.title = isHidden ? 'Minimizar' : 'Expandir';
        }
      });
    }

    // CSV file input handler
    var csvFileInput = document.getElementById('csv-file-input');
    if (csvFileInput) {
      csvFileInput.addEventListener('change', function (e) {
        var file = e.target.files[0];
        if (!file) return;

        var reader = new FileReader();
        reader.onload = function (ev) {
          var csvText = ev.target.result;
          state.toteData = parseCSV(csvText);
          var toteCount = Object.keys(state.toteData).length;

          if (toteCount > 0) {
            state.csvLoaded = true;
            saveCSVData();

            // Calcular total de unidades
            var totalUnits = 0;
            var toteIds = Object.keys(state.toteData);
            for (var t = 0; t < toteIds.length; t++) {
              totalUnits += state.toteData[toteIds[t]].totalQty;
            }

            var statusEl = document.getElementById('csv-status');
            if (statusEl) {
              statusEl.textContent = '✅ Cargado';
              statusEl.style.color = '#36b37e';
            }

            var countEl = document.getElementById('csv-tote-count');
            if (countEl) {
              countEl.style.display = 'block';
              countEl.innerHTML = '✅ <strong>' + toteCount + ' totes</strong> cargados (' + totalUnits + ' uds totales)<br><span style="font-size:11px;color:#8899aa;">Escanea un tote para comenzar</span>';
            }

            // Mostrar botón de reporte si hay shipments indexados
            if (Object.keys(state.shipmentIndex).length > 0) {
              var reportBtnEl = document.getElementById('btn-report-inbound');
            if (reportBtnEl) reportBtnEl.style.display = 'inline-block';
            var monitorBtnEl = document.getElementById('btn-monitor-live');
            if (monitorBtnEl) monitorBtnEl.style.display = 'inline-block';
            }

            // Auto-minimizar el loader del CSV tras cargar (para dejar sitio al progreso)
            var csvContent = document.getElementById('tote-csv-content');
            var minBtn = document.getElementById('tote-minimize-btn');
            if (csvContent && minBtn) {
              csvContent.style.display = 'none';
              minBtn.textContent = '▲';
              minBtn.title = 'Expandir';
            }

            // Si ya había un tote detectado (desde URL) esperando, re-evaluarlo ahora
            // que el CSV está cargado, para auto-detectar sus unidades
            if (state.pendingToteId && !state.active) {
              console.log('[ToteProgress] Re-evaluando tote pendiente tras cargar CSV: ' + state.pendingToteId);
              onToteScanned(state.pendingToteId);
            }
          } else {
            alert('No se encontraron totes en el CSV. Verifica que tiene las columnas "Scannable ID" y "Quantity".');
          }
        };
        reader.readAsText(file);
      });
    }

    // Try to load previously saved CSV data
    if (loadCSVData()) {
      var toteCount = Object.keys(state.toteData).length;
      var statusEl = document.getElementById('csv-status');
      if (statusEl) {
        statusEl.textContent = '✅ CSV previo (' + toteCount + ' totes)';
        statusEl.style.color = '#36b37e';
      }
      var countEl = document.getElementById('csv-tote-count');
      if (countEl) {
        countEl.style.display = 'block';
        countEl.innerHTML = '📄 CSV cargado previamente: <strong>' + toteCount + ' totes</strong><br><span style="font-size:11px;color:#8899aa;">Escanea un tote para comenzar (o carga uno nuevo)</span>';
      }
      // Mostrar botón de reporte si hay shipments
      if (Object.keys(state.shipmentIndex).length > 0) {
        var reportBtnEl2 = document.getElementById('btn-report-inbound');
      if (reportBtnEl2) reportBtnEl2.style.display = 'inline-block';
      var monitorBtnEl2 = document.getElementById('btn-monitor-live');
      if (monitorBtnEl2) monitorBtnEl2.style.display = 'inline-block';
      }
    }

    // Event listeners
    document.getElementById('btn-finalizar-tote').addEventListener('click', finalizarTote);
    document.getElementById('btn-reset-tote').addEventListener('click', function () {
      if (confirm('¿Resetear el progreso de este tote?')) resetTote();
    });
    document.getElementById('btn-cerrar-resumen').addEventListener('click', resetTote);

    // Report button
    var reportBtn = document.getElementById('btn-report-inbound');
    if (reportBtn) {
      reportBtn.addEventListener('click', openReportModal);
    }
    // Report modal event listeners
    var reportBtnStart = document.getElementById('report-btn-start');
    if (reportBtnStart) reportBtnStart.addEventListener('click', startReportScraping);
    var reportBtnCancel = document.getElementById('report-btn-cancel');
    if (reportBtnCancel) reportBtnCancel.addEventListener('click', function () {
      document.getElementById('report-modal').style.display = 'none';
    });
    var reportBtnAbort = document.getElementById('report-btn-abort');
    if (reportBtnAbort) reportBtnAbort.addEventListener('click', function () { reportAbortFlag = true; });
    var reportBtnDownload = document.getElementById('report-btn-download');
    if (reportBtnDownload) reportBtnDownload.addEventListener('click', downloadReport);
    var reportBtnClose = document.getElementById('report-btn-close');
    if (reportBtnClose) reportBtnClose.addEventListener('click', function () {
      document.getElementById('report-modal').style.display = 'none';
    });
    var reportBtnPrescan = document.getElementById('report-btn-prescan');
    if (reportBtnPrescan) reportBtnPrescan.addEventListener('click', startPrescan);

    var monitorBtn = document.getElementById('btn-monitor-live');
    if (monitorBtn) monitorBtn.addEventListener('click', toggleMonitorLive);

    // FNSKU detail toggle
    var toggle = document.getElementById('tote-fnsku-toggle');
    var detailDiv = document.getElementById('tote-fnsku-detail');
    if (toggle && detailDiv) {
      toggle.addEventListener('click', function() {
        if (detailDiv.style.display === 'none' || !detailDiv.style.display) {
          detailDiv.style.display = 'block';
          toggle.textContent = '▲ Ocultar detalle';
        } else {
          detailDiv.style.display = 'none';
          toggle.textContent = '▼ Ver detalle por FNSKU';
        }
      });
    }

    // Start watching inputs
    watchInputs();

    // Detectar toteId desde la URL (receiveProduct?toteId=...)
    detectToteFromURL();

    console.log('[ToteProgress] Extension v' + CONFIG.VERSION + ' injected (' + 
      (state.csvLoaded ? Object.keys(state.toteData).length + ' totes loaded' : 'no CSV') + ')');
  }

  // =========================================================
  // MÓDULO DE REPORTE INBOUND (PC only)
  // Scrapea FAAST para obtener bins y genera Excel
  // =========================================================

  // --- FAAST Audit API (JSON endpoint) ---
  var AUDIT_API = '/web/ajax/inventory/auditSearch/getInventoryAudit';

  // Build date range: 7 days back from today, 1 day forward
  function getAuditDateRange() {
    var now = new Date();
    var from = new Date(now);
    from.setDate(from.getDate() - 7);
    var to = new Date(now);
    to.setDate(to.getDate() + 1);
    // FAAST uses MM/DD/YYYY format for dates
    function fmt(d) {
      return String(d.getMonth() + 1).padStart(2, '0') + '/' +
             String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear();
    }
    return { from: fmt(from), to: fmt(to) };
  }

  // Query audit API — returns Promise<{auditItems:[], matchingItemsCount:N}>
  function queryAudit(params) {
    var dates = getAuditDateRange();
    var body = {
      adjustmentType: params.adjustmentType || 'RECEIVE',
      fromCreationDate: params.fromDate || dates.from,
      toCreationDate: params.toDate || dates.to,
      inventoryType: 'All',
      lotNumber: '',
      scannableId: params.scannableId || '',
      sku: params.sku || '',
      userId: 'All',
      page: { pageNumber: params.pageNumber || 0, pageSize: params.pageSize || 100 }
    };
    return fetch(AUDIT_API, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  // Query ALL pages of audit for given params
  function queryAllAuditPages(params) {
    var allItems = [];
    var pageSize = params.pageSize || 100;

    function fetchPage(pageNum) {
      var p = Object.assign({}, params, { pageNumber: pageNum, pageSize: pageSize });
      return queryAudit(p).then(function (result) {
        var items = result.auditItems || [];
        allItems = allItems.concat(items);
        var total = result.matchingItemsCount || 0;
        // If we got a full page and there are more items, fetch next page
        if (items.length >= pageSize && allItems.length < total) {
          return fetchPage(pageNum + 1);
        }
        return allItems;
      });
    }
    return fetchPage(0);
  }

  // Parse audit item from API response into our internal format
  function parseAuditItem(item) {
    return {
      fnsku: item.sku || '',
      quantity: item.quantity || 0,
      bin: item.destinationScannableId || item.auditComment || '',
      user: String(item.userId || ''),
      date: item.creationDate ? new Date(item.creationDate).toLocaleString() : '',
      sourceScannableId: item.sourceScannableId || ''
    };
  }

  // Resolve userId numbers to userNames via FAAST API
  function resolveUserNames(userIds) {
    // userIds: array of unique userId strings
    // Returns Promise<{userId: userName}>
    var userMap = {};
    if (!userIds || userIds.length === 0) return Promise.resolve(userMap);

    var chain = Promise.resolve();
    for (var i = 0; i < userIds.length; i++) {
      chain = chain.then((function (uid) {
        return function () {
          return fetch('/web/ajax/account/getUserAccountById?userId=' + uid, { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (data && data.user && data.user.userName) {
                userMap[uid] = data.user.userName;
              } else {
                userMap[uid] = uid; // fallback to ID
              }
            })
            .catch(function () { userMap[uid] = uid; });
        };
      })(userIds[i]));
    }
    return chain.then(function () { return userMap; });
  }

  // Replace userId with userName in allReceives array
  function applyUserNames(allReceives, userMap) {
    for (var i = 0; i < allReceives.length; i++) {
      var uid = allReceives[i].user;
      if (userMap[uid]) allReceives[i].user = userMap[uid];
    }
  }

  // --- Excel generation (XML Spreadsheet 2003 format) ---
  function escapeXml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function generateExcelXML(reportData) {
    var xml = '<?xml version="1.0"?>\n';
    xml += '<?mso-application progid="Excel.Sheet"?>\n';
    xml += '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n';
    xml += ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n';

    // Styles
    xml += '<Styles>\n';
    xml += '<Style ss:ID="header"><Font ss:Bold="1" ss:Size="11"/><Interior ss:Color="#FF9900" ss:Pattern="Solid"/></Style>\n';
    xml += '<Style ss:ID="ok"><Interior ss:Color="#C6EFCE" ss:Pattern="Solid"/></Style>\n';
    xml += '<Style ss:ID="warn"><Interior ss:Color="#FFEB9C" ss:Pattern="Solid"/></Style>\n';
    xml += '<Style ss:ID="alert"><Interior ss:Color="#FFC7CE" ss:Pattern="Solid"/></Style>\n';
    xml += '<Style ss:ID="normal"></Style>\n';
    xml += '</Styles>\n';

    // --- Sheet 1: Resumen por Tote ---
    xml += '<Worksheet ss:Name="Resumen por Tote">\n<Table>\n';
    var headers1 = ['Tote ID', 'Transfer ID', 'Esperadas', 'Recibidas', 'Pendientes', '% Completado', 'Estado', 'Ubicado por'];
    xml += '<Row>';
    for (var h = 0; h < headers1.length; h++) {
      xml += '<Cell ss:StyleID="header"><Data ss:Type="String">' + escapeXml(headers1[h]) + '</Data></Cell>';
    }
    xml += '</Row>\n';

    var toteIds = Object.keys(reportData.totes);
    // Sort: incomplete first, then not started, then complete
    toteIds.sort(function (a, b) {
      var ta = reportData.totes[a], tb = reportData.totes[b];
      var pctA = ta.expected > 0 ? ta.received / ta.expected : 0;
      var pctB = tb.expected > 0 ? tb.received / tb.expected : 0;
      // Incomplete (0 < pct < 1) first, then not started (0), then complete (1)
      var orderA = pctA === 0 ? 1 : (pctA < 1 ? 0 : 2);
      var orderB = pctB === 0 ? 1 : (pctB < 1 ? 0 : 2);
      return orderA - orderB || pctA - pctB;
    });

    for (var ti = 0; ti < toteIds.length; ti++) {
      var tote = reportData.totes[toteIds[ti]];
      var pct = tote.expected > 0 ? Math.round(tote.received / tote.expected * 100) : 0;
      var estado = pct === 0 ? 'Sin empezar' : (pct >= 100 ? 'Completo' : 'Incompleto');
      var style = pct === 0 ? 'alert' : (pct >= 100 ? 'ok' : 'warn');
      xml += '<Row>';
      xml += '<Cell ss:StyleID="' + style + '"><Data ss:Type="String">' + escapeXml(toteIds[ti]) + '</Data></Cell>';
      xml += '<Cell><Data ss:Type="String">' + escapeXml(tote.transferId || '') + '</Data></Cell>';
      xml += '<Cell><Data ss:Type="Number">' + tote.expected + '</Data></Cell>';
      xml += '<Cell><Data ss:Type="Number">' + tote.received + '</Data></Cell>';
      xml += '<Cell><Data ss:Type="Number">' + Math.max(0, tote.expected - tote.received) + '</Data></Cell>';
      xml += '<Cell><Data ss:Type="Number">' + pct + '</Data></Cell>';
      xml += '<Cell ss:StyleID="' + style + '"><Data ss:Type="String">' + escapeXml(estado) + '</Data></Cell>';
      // Collect users from all fnskuDetails of this tote
      var toteUsers = [];
      var fds = tote.fnskuDetail || [];
      for (var fu = 0; fu < fds.length; fu++) {
        var uu = fds[fu].users || [];
        for (var ui = 0; ui < uu.length; ui++) { if (toteUsers.indexOf(uu[ui]) === -1) toteUsers.push(uu[ui]); }
      }
      xml += '<Cell><Data ss:Type="String">' + escapeXml(toteUsers.join(', ')) + '</Data></Cell>';
      xml += '</Row>\n';
    }
    xml += '</Table>\n</Worksheet>\n';

    // --- Sheet 2: Detalle por FNSKU ---
    xml += '<Worksheet ss:Name="Detalle FNSKU">\n<Table>\n';
    var headers2 = ['Tote ID', 'FNSKU', 'Esperadas', 'Recibidas', 'Pendientes', 'Bin(s)', 'Recibido por', 'Fecha recepción', 'Estado'];
    xml += '<Row>';
    for (var h2 = 0; h2 < headers2.length; h2++) {
      xml += '<Cell ss:StyleID="header"><Data ss:Type="String">' + escapeXml(headers2[h2]) + '</Data></Cell>';
    }
    xml += '</Row>\n';

    for (var di = 0; di < toteIds.length; di++) {
      var toteDetail = reportData.totes[toteIds[di]];
      var fnskuList = toteDetail.fnskuDetail || [];
      for (var fi = 0; fi < fnskuList.length; fi++) {
        var fd = fnskuList[fi];
        var pending = Math.max(0, fd.expected - fd.received);
        var fdEstado = fd.received === 0 ? 'Sin recibir' : (pending === 0 ? 'Completo' : 'Parcial');
        var fdStyle = fd.received === 0 ? 'alert' : (pending === 0 ? 'ok' : 'warn');
        xml += '<Row>';
        xml += '<Cell><Data ss:Type="String">' + escapeXml(toteIds[di]) + '</Data></Cell>';
        xml += '<Cell><Data ss:Type="String">' + escapeXml(fd.fnsku) + '</Data></Cell>';
        xml += '<Cell><Data ss:Type="Number">' + fd.expected + '</Data></Cell>';
        xml += '<Cell><Data ss:Type="Number">' + fd.received + '</Data></Cell>';
        xml += '<Cell><Data ss:Type="Number">' + pending + '</Data></Cell>';
        xml += '<Cell><Data ss:Type="String">' + escapeXml((fd.bins || []).join(', ')) + '</Data></Cell>';
        xml += '<Cell><Data ss:Type="String">' + escapeXml((fd.users || []).join(', ')) + '</Data></Cell>';
        xml += '<Cell><Data ss:Type="String">' + escapeXml(fd.lastDate || '') + '</Data></Cell>';
        xml += '<Cell ss:StyleID="' + fdStyle + '"><Data ss:Type="String">' + escapeXml(fdEstado) + '</Data></Cell>';
        xml += '</Row>\n';
      }
    }
    xml += '</Table>\n</Worksheet>\n';

    // --- Sheet 3: Totes Incompletos (resumen rápido) ---
    xml += '<Worksheet ss:Name="Totes Incompletos">\n<Table>\n';
    var headers3 = ['Tote ID', 'Esperadas', 'Recibidas', 'Pendientes', 'FNSKUs pendientes'];
    xml += '<Row>';
    for (var h3 = 0; h3 < headers3.length; h3++) {
      xml += '<Cell ss:StyleID="header"><Data ss:Type="String">' + escapeXml(headers3[h3]) + '</Data></Cell>';
    }
    xml += '</Row>\n';

    for (var ii = 0; ii < toteIds.length; ii++) {
      var it = reportData.totes[toteIds[ii]];
      if (it.received >= it.expected && it.expected > 0) continue; // Skip complete
      var pendingFnskus = [];
      var fnskusDet = it.fnskuDetail || [];
      for (var pf = 0; pf < fnskusDet.length; pf++) {
        if (fnskusDet[pf].received < fnskusDet[pf].expected) {
          pendingFnskus.push(fnskusDet[pf].fnsku + '(' + (fnskusDet[pf].expected - fnskusDet[pf].received) + ')');
        }
      }
      xml += '<Row>';
      xml += '<Cell ss:StyleID="warn"><Data ss:Type="String">' + escapeXml(toteIds[ii]) + '</Data></Cell>';
      xml += '<Cell><Data ss:Type="Number">' + it.expected + '</Data></Cell>';
      xml += '<Cell><Data ss:Type="Number">' + it.received + '</Data></Cell>';
      xml += '<Cell><Data ss:Type="Number">' + Math.max(0, it.expected - it.received) + '</Data></Cell>';
      xml += '<Cell><Data ss:Type="String">' + escapeXml(pendingFnskus.join(', ')) + '</Data></Cell>';
      xml += '</Row>\n';
    }
    xml += '</Table>\n</Worksheet>\n';

    xml += '</Workbook>';
    return xml;
  }

  // --- Download helper ---
  function downloadFile(content, filename, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  // --- Report UI ---
  function createReportModal() {
    var modal = document.createElement('div');
    modal.id = 'report-modal';
    modal.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:100000;overflow-y:auto;';
    modal.innerHTML =
      '<div style="max-width:600px;margin:60px auto;background:#1a2332;border-radius:12px;border:2px solid #ff9900;padding:24px;">' +
        '<h2 style="color:#ff9900;margin:0 0 16px;font-size:18px;">📥 Reporte Inbound</h2>' +
        '<div id="report-step-select" style="display:block;">' +
          '<label style="color:#ccc;font-size:13px;display:block;margin-bottom:6px;">Selecciona los totes a reportar:</label>' +
          '<input id="report-tote-filter" type="text" placeholder="🔍 Filtrar totes..." style="width:100%;padding:8px 10px;background:#0d1520;color:#fff;border:1px solid #334;border-radius:6px;font-size:13px;margin-bottom:6px;box-sizing:border-box;" />' +
          '<div id="report-tote-list" style="max-height:280px;overflow-y:auto;border:1px solid #334;border-radius:6px;background:#0d1520;margin-bottom:8px;"></div>' +
          '<div id="report-selection-info" style="color:#ff9900;font-size:12px;font-weight:600;margin-bottom:4px;"></div>' +
          '<div id="report-shipment-info" style="color:#8899aa;font-size:12px;margin-bottom:16px;"></div>' +
          '<div style="display:flex;gap:10px;">' +
            '<button id="report-btn-prescan" style="padding:12px;background:#1a3a5c;color:#6bb5ff;font-weight:600;border:1px solid #2a5a8c;border-radius:8px;cursor:pointer;font-size:13px;white-space:nowrap;" title="Consulta FAAST para detectar totes con recepción parcial">🔍 PRE-SCAN</button>' +
            '<button id="report-btn-start" style="flex:1;padding:12px;background:#ff9900;color:#000;font-weight:700;border:none;border-radius:8px;cursor:pointer;font-size:14px;">🔍 INICIAR SCRAPING</button>' +
            '<button id="report-btn-cancel" style="padding:12px 20px;background:#333;color:#fff;border:1px solid #555;border-radius:8px;cursor:pointer;font-size:14px;">Cancelar</button>' +
          '</div>' +
        '</div>' +
        '<div id="report-step-progress" style="display:none;">' +
          '<div style="color:#ccc;font-size:13px;margin-bottom:8px;">Consultando FAAST...</div>' +
          '<div id="report-progress-info" style="color:#ff9900;font-size:14px;font-weight:600;margin-bottom:8px;"></div>' +
          '<div style="background:#0d1520;border-radius:8px;overflow:hidden;height:24px;margin-bottom:8px;">' +
            '<div id="report-progress-bar" style="height:100%;background:linear-gradient(90deg,#ff9900,#ffb84d);width:0%;transition:width 0.3s;border-radius:8px;"></div>' +
          '</div>' +
          '<div id="report-progress-detail" style="color:#8899aa;font-size:11px;max-height:120px;overflow-y:auto;"></div>' +
          '<div style="margin-top:12px;">' +
            '<button id="report-btn-abort" style="padding:10px 20px;background:#cc3333;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;">⛔ CANCELAR</button>' +
          '</div>' +
        '</div>' +
        '<div id="report-step-done" style="display:none;">' +
          '<div style="text-align:center;padding:20px 0;">' +
            '<div style="font-size:40px;margin-bottom:8px;">✅</div>' +
            '<div style="color:#36b37e;font-size:16px;font-weight:700;margin-bottom:4px;">Reporte generado</div>' +
            '<div id="report-done-summary" style="color:#ccc;font-size:13px;margin-bottom:16px;"></div>' +
            '<button id="report-btn-download" style="padding:12px 30px;background:#ff9900;color:#000;font-weight:700;border:none;border-radius:8px;cursor:pointer;font-size:14px;">📥 DESCARGAR EXCEL</button>' +
            '<button id="report-btn-close" style="margin-left:10px;padding:12px 20px;background:#333;color:#fff;border:1px solid #555;border-radius:8px;cursor:pointer;font-size:13px;">Cerrar</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    return modal;
  }

  function openReportModal() {
    if (!state.csvLoaded || Object.keys(state.shipmentIndex).length === 0) {
      alert('⚠️ Primero carga un CSV con la columna "Transfer Request ID".');
      return;
    }

    // --- Read local progress for all totes ---
    var toteStatus = {};  // { toteId: { received, expected, source:'local'|'faast'|null } }
    var allToteIds = Object.keys(state.toteData);
    for (var lp = 0; lp < allToteIds.length; lp++) {
      var lpTid = allToteIds[lp];
      var lpData = loadProgress(lpTid);
      if (lpData && lpData.receivedUnits > 0) {
        toteStatus[lpTid] = { received: lpData.receivedUnits, expected: lpData.expectedUnits || state.toteData[lpTid].totalQty, source: 'local' };
      }
    }

    function getStatusBadge(toteId) {
      // Check prescan data first, then local progress data
      var ts = (state.prescanStatus && state.prescanStatus[toteId]) || toteStatus[toteId];
      var expected = state.toteData[toteId] ? state.toteData[toteId].totalQty : 0;
      if (!ts) return '<span style="color:#555;font-size:10px;" title="Sin datos — usa Pre-scan">⬜ ?</span>';
      var rcv = ts.received;
      if (rcv >= expected && expected > 0) {
        return '<span style="color:#36b37e;font-size:10px;font-weight:700;">✅ ' + rcv + '/' + expected + '</span>';
      } else if (rcv > 0) {
        return '<span style="color:#ffb84d;font-size:10px;font-weight:700;">⚠️ ' + rcv + '/' + expected + '</span>';
      } else {
        return '<span style="color:#ff4444;font-size:10px;font-weight:700;">❌ 0/' + expected + '</span>';
      }
    }

    var modal = document.getElementById('report-modal');
    var listDiv = document.getElementById('report-tote-list');
    var filterInput = document.getElementById('report-tote-filter');
    var selInfo = document.getElementById('report-selection-info');
    var info = document.getElementById('report-shipment-info');

    // Build tote list grouped by transfer, sorted by tote count desc
    var selectedTotes = {};  // { toteId: true }

    // Group totes by transfer
    var transfers = {};  // { transferId: [toteId, ...] }
    var allToteIds = Object.keys(state.toteData);
    for (var t = 0; t < allToteIds.length; t++) {
      var tid = allToteIds[t];
      var trId = state.toteData[tid].transferId || 'Sin transfer';
      if (!transfers[trId]) transfers[trId] = [];
      transfers[trId].push(tid);
    }
    // Sort transfers by number of totes desc
    var transferKeys = Object.keys(transfers);
    transferKeys.sort(function (a, b) { return transfers[b].length - transfers[a].length; });

    // Truncate transfer ID for group header
    function shortTransfer(id) {
      if (id.length <= 45) return id;
      return id.substring(0, 20) + '…' + id.substring(id.length - 16);
    }

    function updateSelectionInfo() {
      var count = Object.keys(selectedTotes).length;
      var totalUnits = 0;
      var uniqueFnskus = {};
      for (var sid in selectedTotes) {
        var td = state.toteData[sid];
        if (td) {
          totalUnits += td.totalQty;
          for (var f = 0; f < td.fnskus.length; f++) uniqueFnskus[td.fnskus[f].fnsku] = true;
        }
      }
      selInfo.textContent = count > 0
        ? '✅ ' + count + ' totes seleccionados · ' + Object.keys(uniqueFnskus).length + ' FNSKUs · ' + totalUnits + ' uds'
        : '';
      var fnskuCount = Object.keys(uniqueFnskus).length;
      info.innerHTML = count > 0
        ? '<span style="color:#ffb84d;">⏱️ Scraping estimado: ~' + Math.ceil(fnskuCount * 1.5 / 60) + ' min (' + fnskuCount + ' consultas)</span>'
        : '<span style="color:#666;">Selecciona totes de la lista</span>';
    }

    function renderList(filter) {
      listDiv.innerHTML = '';
      var filterLower = (filter || '').toLowerCase();
      var anyShown = false;

      for (var g = 0; g < transferKeys.length; g++) {
        var trId = transferKeys[g];
        var totes = transfers[trId];
        // Filter totes
        var filteredTotes = filterLower ? totes.filter(function (tid) { return tid.toLowerCase().indexOf(filterLower) !== -1; }) : totes;
        if (filteredTotes.length === 0) continue;
        anyShown = true;

        // Sort: incomplete (⚠️) first, then not started (❌), then complete (✅), then unknown (⬜)
        filteredTotes.sort(function (a, b) {
          var sa = (state.prescanStatus && state.prescanStatus[a]) || null;
          var sb = (state.prescanStatus && state.prescanStatus[b]) || null;
          var ea = state.toteData[a] ? state.toteData[a].totalQty : 0;
          var eb = state.toteData[b] ? state.toteData[b].totalQty : 0;
          function order(s, exp) {
            if (!s) return 3;  // unknown → last
            if (s.received > 0 && s.received < exp) return 0;  // incomplete → first
            if (s.received === 0) return 1;  // not started
            return 2;  // complete
          }
          var oa = order(sa, ea), ob = order(sb, eb);
          if (oa !== ob) return oa - ob;
          return 0;
        });

        // Group header with "select all" for this transfer
        var header = document.createElement('div');
        header.style.cssText = 'padding:6px 10px;background:#0f1a28;border-bottom:1px solid #1e2d40;display:flex;justify-content:space-between;align-items:center;';
        header.innerHTML =
          '<span style="color:#8899aa;font-size:10px;font-weight:600;" title="' + trId + '">📦 ' + shortTransfer(trId) + ' (' + totes.length + ')</span>' +
          '<a href="#" class="report-select-group" data-trid="' + trId + '" style="color:#ff9900;font-size:10px;text-decoration:none;">seleccionar todos</a>';
        listDiv.appendChild(header);

        // Tote rows
        for (var ti = 0; ti < filteredTotes.length; ti++) {
          var toteId = filteredTotes[ti];
          var td = state.toteData[toteId];
          var checked = selectedTotes[toteId] ? ' checked' : '';
          var row = document.createElement('div');
          row.style.cssText = 'padding:5px 10px 5px 20px;border-bottom:1px solid #141f2e;cursor:pointer;display:flex;align-items:center;gap:8px;';
          row.innerHTML =
            '<input type="checkbox" data-tote="' + toteId + '"' + checked + ' style="accent-color:#ff9900;cursor:pointer;" />' +
            '<span style="color:#fff;font-size:12px;font-weight:600;min-width:120px;">' + toteId + '</span>' +
            '<span style="color:#8899aa;font-size:11px;">' + (td ? td.totalQty + ' uds · ' + td.fnskus.length + ' FNSKUs' : '') + '</span>' +
            '<span style="margin-left:auto;">' + getStatusBadge(toteId) + '</span>';
          listDiv.appendChild(row);
        }
      }
      if (!anyShown) {
        listDiv.innerHTML = '<div style="padding:12px;color:#666;text-align:center;font-size:12px;">Sin resultados para "' + filter + '"</div>';
      }

      // Wire checkbox and group-select listeners
      listDiv.querySelectorAll('input[type=checkbox][data-tote]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          if (this.checked) selectedTotes[this.getAttribute('data-tote')] = true;
          else delete selectedTotes[this.getAttribute('data-tote')];
          updateSelectionInfo();
        });
      });
      listDiv.querySelectorAll('.report-select-group').forEach(function (link) {
        link.addEventListener('click', function (e) {
          e.preventDefault();
          var gTotes = transfers[this.getAttribute('data-trid')] || [];
          // Toggle: if all selected → deselect all; else select all
          var allSelected = gTotes.every(function (t) { return selectedTotes[t]; });
          for (var j = 0; j < gTotes.length; j++) {
            if (allSelected) delete selectedTotes[gTotes[j]];
            else selectedTotes[gTotes[j]] = true;
          }
          renderList(filterInput.value);
          updateSelectionInfo();
        });
      });
    }

    // Store selectedTotes on state for startReportScraping
    state.reportSelectedTotes = selectedTotes;

    filterInput.value = '';
    filterInput.addEventListener('input', function () { renderList(this.value); });
    state._renderListFn = renderList;
    renderList('');
    updateSelectionInfo();

    // Show select step, hide others
    document.getElementById('report-step-select').style.display = 'block';
    document.getElementById('report-step-progress').style.display = 'none';
    document.getElementById('report-step-done').style.display = 'none';
    modal.style.display = 'block';
  }

  // --- Main scraping function ---
  var reportAbortFlag = false;

  // --- Pre-scan: quick check which totes have received units ---
  function startPrescan() {
    var allToteIds = Object.keys(state.toteData);
    if (allToteIds.length === 0) return;

    var prescanBtn = document.getElementById('report-btn-prescan');
    if (prescanBtn) {
      prescanBtn.disabled = true;
      prescanBtn.textContent = '⏳ Consultando FAAST...';
      prescanBtn.style.opacity = '0.6';
    }

    // Strategy: query by scannableId (Transfer Request ID) to get ALL receives
    // for the entire transfer in one shot. Then distribute to totes by FNSKU.
    if (!state.prescanStatus) state.prescanStatus = {};

    // Get unique transfer IDs
    var transferIds = {};
    for (var t = 0; t < allToteIds.length; t++) {
      var td = state.toteData[allToteIds[t]];
      if (td && td.transferId) transferIds[td.transferId] = true;
    }
    var transfers = Object.keys(transferIds);
    if (prescanBtn) prescanBtn.textContent = '⏳ ' + transfers.length + ' transfer(s)...';

    // Build a FNSKU→totes map for distributing received quantities
    var fnskuToTotes = {};
    for (var t2 = 0; t2 < allToteIds.length; t2++) {
      var td2 = state.toteData[allToteIds[t2]];
      if (!td2) continue;
      for (var f = 0; f < td2.fnskus.length; f++) {
        var fk = td2.fnskus[f].fnsku;
        if (!fnskuToTotes[fk]) fnskuToTotes[fk] = [];
        fnskuToTotes[fk].push({ toteId: allToteIds[t2], qty: td2.fnskus[f].qty });
      }
    }

    // Query each transfer (usually just 1) and get ALL received items
    var completed = 0;
    function processTransfer(trId) {
      return queryAllAuditPages({ scannableId: trId, adjustmentType: 'RECEIVE', pageSize: 100 })
        .then(function (items) {
          if (prescanBtn) prescanBtn.textContent = '⏳ ' + items.length + ' items recibidos...';
          // Group received qty by FNSKU
          var rcvByFnsku = {};
          for (var i = 0; i < items.length; i++) {
            var sku = items[i].sku || '';
            rcvByFnsku[sku] = (rcvByFnsku[sku] || 0) + (items[i].quantity || 0);
          }
          // Distribute to totes: for each received FNSKU, fill totes in order
          for (var fnsku in rcvByFnsku) {
            var totes = fnskuToTotes[fnsku] || [];
            var remaining = rcvByFnsku[fnsku];
            for (var j = 0; j < totes.length && remaining > 0; j++) {
              var tid = totes[j].toteId;
              var assign = Math.min(remaining, totes[j].qty);
              if (!state.prescanStatus[tid]) {
                state.prescanStatus[tid] = { received: 0, expected: state.toteData[tid].totalQty };
              }
              state.prescanStatus[tid].received += assign;
              remaining -= assign;
            }
          }
          completed++;
        });
    }

    // Run all transfers sequentially (usually just 1)
    var chain = Promise.resolve();
    for (var tr = 0; tr < transfers.length; tr++) {
      chain = chain.then((function (id) { return function () { return processTransfer(id); }; })(transfers[tr]));
    }
    chain.then(function () {
      if (prescanBtn) {
        prescanBtn.textContent = '✅ SCAN LISTO';
        prescanBtn.disabled = false;
        prescanBtn.style.opacity = '1';
      }
      var filterInput = document.getElementById('report-tote-filter');
      if (state._renderListFn) state._renderListFn(filterInput ? filterInput.value : '');
    }).catch(function (err) {
      if (prescanBtn) {
        prescanBtn.textContent = '❌ Error';
        prescanBtn.disabled = false;
        prescanBtn.style.opacity = '1';
      }
      console.error('[ToteProgress] Prescan error:', err);
    });
  }

  function startReportScraping() {
    var selectedTotes = state.reportSelectedTotes || {};
    var toteIds = Object.keys(selectedTotes);
    if (toteIds.length === 0) {
      alert('⚠️ Selecciona al menos un tote.');
      return;
    }

    reportAbortFlag = false;
    state.reportInProgress = true;

    // Switch to progress view
    document.getElementById('report-step-select').style.display = 'none';
    document.getElementById('report-step-progress').style.display = 'block';

    var progressBar = document.getElementById('report-progress-bar');
    var progressInfo = document.getElementById('report-progress-info');
    var progressDetail = document.getElementById('report-progress-detail');

    // Collect transfer IDs and FNSKUs from selected totes
    var selectedTransferIds = {};
    var uniqueFnskus = {};
    for (var t = 0; t < toteIds.length; t++) {
      var td = state.toteData[toteIds[t]];
      if (!td) continue;
      if (td.transferId) selectedTransferIds[td.transferId] = true;
      for (var f = 0; f < td.fnskus.length; f++) {
        var fk = td.fnskus[f].fnsku;
        if (!uniqueFnskus[fk]) uniqueFnskus[fk] = { expected: 0, totes: [] };
        uniqueFnskus[fk].expected += td.fnskus[f].qty;
        if (uniqueFnskus[fk].totes.indexOf(toteIds[t]) === -1) {
          uniqueFnskus[fk].totes.push(toteIds[t]);
        }
      }
    }

    var transfers = Object.keys(selectedTransferIds);
    var allReceives = [];
    var errors = [];

    progressInfo.textContent = 'Consultando ' + transfers.length + ' transfer(s)...';
    progressBar.style.width = '10%';

    // Query ALL receives for each transfer via API (usually just 1 transfer)
    var completed = 0;
    function processTransfer(trId) {
      progressDetail.innerHTML += '<div>📦 Consultando transfer: ' + trId.substring(0, 40) + '...</div>';
      progressDetail.scrollTop = progressDetail.scrollHeight;

      return queryAllAuditPages({ scannableId: trId, adjustmentType: 'RECEIVE', pageSize: 100 })
        .then(function (items) {
          progressBar.style.width = '50%';
          progressInfo.textContent = items.length + ' items recibidos encontrados';
          progressDetail.innerHTML += '<div>✅ ' + items.length + ' items encontrados</div>';

          for (var i = 0; i < items.length; i++) {
            var parsed = parseAuditItem(items[i]);
            var sku = items[i].sku || '';
            parsed.expectedTotes = uniqueFnskus[sku] ? uniqueFnskus[sku].totes : [];
            allReceives.push(parsed);
          }
          completed++;
        })
        .catch(function (err) {
          errors.push(trId);
          progressDetail.innerHTML += '<div>❌ Error: ' + err.message + '</div>';
        });
    }

    // Run transfers sequentially
    var chain = Promise.resolve();
    for (var tr = 0; tr < transfers.length; tr++) {
      chain = chain.then((function (id) { return function () { return processTransfer(id); }; })(transfers[tr]));
    }
    chain.then(function () {
      progressBar.style.width = '80%';
      progressInfo.textContent = 'Resolviendo nombres de usuarios...';
      // Collect unique userIds
      var uniqueUsers = {};
      for (var u = 0; u < allReceives.length; u++) {
        var uid = allReceives[u].user;
        if (uid && uid !== 'undefined') uniqueUsers[uid] = true;
      }
      return resolveUserNames(Object.keys(uniqueUsers)).then(function (userMap) {
        applyUserNames(allReceives, userMap);
        progressBar.style.width = '95%';
        progressInfo.textContent = 'Generando reporte...';
        finishReport(toteIds, uniqueFnskus, allReceives, errors);
      });
    });
  }

  function finishReport(toteIds, uniqueFnskus, allReceives, errors) {
    state.reportInProgress = false;

    // Build report data structure: per-tote, per-fnsku
    var reportData = { totes: {}, generatedAt: new Date().toISOString() };

    // Initialize totes from selected tote list
    for (var t = 0; t < toteIds.length; t++) {
      var tid = toteIds[t];
      var csvTote = state.toteData[tid];
      if (!csvTote) continue;
      reportData.totes[tid] = {
        transferId: csvTote.transferId || '',
        expected: csvTote.totalQty,
        received: 0,
        fnskuDetail: []
      };
      // Add FNSKU details
      for (var f = 0; f < csvTote.fnskus.length; f++) {
        reportData.totes[tid].fnskuDetail.push({
          fnsku: csvTote.fnskus[f].fnsku,
          expected: csvTote.fnskus[f].qty,
          received: 0,
          bins: [],
          users: [],
          lastDate: ''
        });
      }
    }

    // Map received items to totes/fnskus
    // The audit history tells us FNSKU + bin + qty, but not directly which tote
    // We aggregate by FNSKU across all totes of this shipment
    var fnskuReceived = {}; // { fnsku: { totalReceived, bins: [], users: [], lastDate } }
    for (var r = 0; r < allReceives.length; r++) {
      var rcv = allReceives[r];
      if (!fnskuReceived[rcv.fnsku]) {
        fnskuReceived[rcv.fnsku] = { totalReceived: 0, bins: [], users: [], lastDate: '' };
      }
      var fr = fnskuReceived[rcv.fnsku];
      fr.totalReceived += rcv.quantity;
      if (rcv.bin && fr.bins.indexOf(rcv.bin) === -1) fr.bins.push(rcv.bin);
      if (rcv.user && fr.users.indexOf(rcv.user) === -1) fr.users.push(rcv.user);
      if (rcv.date > fr.lastDate) fr.lastDate = rcv.date;
    }

    // Distribute received quantities to totes (fill in order)
    var toteIds = Object.keys(reportData.totes);
    for (var fnsku in fnskuReceived) {
      var remaining = fnskuReceived[fnsku].totalReceived;
      var info = fnskuReceived[fnsku];

      for (var ti = 0; ti < toteIds.length && remaining > 0; ti++) {
        var tote = reportData.totes[toteIds[ti]];
        for (var fd = 0; fd < tote.fnskuDetail.length; fd++) {
          if (tote.fnskuDetail[fd].fnsku === fnsku && remaining > 0) {
            var canAssign = Math.min(remaining, tote.fnskuDetail[fd].expected);
            tote.fnskuDetail[fd].received = canAssign;
            tote.fnskuDetail[fd].bins = info.bins;
            tote.fnskuDetail[fd].users = info.users;
            tote.fnskuDetail[fd].lastDate = info.lastDate;
            remaining -= canAssign;
          }
        }
      }
    }

    // Calculate tote-level totals
    for (var tk in reportData.totes) {
      var tot = reportData.totes[tk];
      var totalRcv = 0;
      for (var fd2 = 0; fd2 < tot.fnskuDetail.length; fd2++) {
        totalRcv += tot.fnskuDetail[fd2].received;
      }
      tot.received = totalRcv;
    }

    // Store for download
    state.lastReportData = reportData;
    state.lastReportXML = generateExcelXML(reportData);

    // Show done step
    document.getElementById('report-step-progress').style.display = 'none';
    document.getElementById('report-step-done').style.display = 'block';

    // Summary
    var totalTotes = toteIds.length;
    var completeTotes = 0, incompleteTotes = 0, notStarted = 0;
    for (var ts = 0; ts < toteIds.length; ts++) {
      var tt = reportData.totes[toteIds[ts]];
      if (tt.received === 0) notStarted++;
      else if (tt.received >= tt.expected) completeTotes++;
      else incompleteTotes++;
    }
    var summaryEl = document.getElementById('report-done-summary');
    summaryEl.innerHTML =
      '📦 <strong>' + totalTotes + '</strong> totes | ' +
      '✅ <strong style="color:#36b37e;">' + completeTotes + '</strong> completos | ' +
      '⚠️ <strong style="color:#ffb84d;">' + incompleteTotes + '</strong> incompletos | ' +
      '❌ <strong style="color:#ff4444;">' + notStarted + '</strong> sin empezar' +
      (errors.length > 0 ? '<br>⚠️ ' + errors.length + ' FNSKUs con error de consulta' : '');
  }

  function downloadReport() {
    if (!state.lastReportXML) return;
    var now = new Date();
    var dateStr = now.getFullYear() + '' +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + '_' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0');
    var filename = 'Reporte_Inbound_' + dateStr + '.xls';
    downloadFile(state.lastReportXML, filename, 'application/vnd.ms-excel');
  }

  // =========================================================
  // MONITOR LIVE — Dashboard de progreso en tiempo real
  // Consulta FAAST cada 60s y actualiza la vista
  // =========================================================
  var monitorInterval = null;
  var monitorActive = false;

  function toggleMonitorLive() {
    if (monitorActive) {
      stopMonitor();
    } else {
      startMonitor();
    }
  }

  function startMonitor() {
    if (!state.csvLoaded || Object.keys(state.shipmentIndex).length === 0) {
      alert('⚠️ Primero carga un CSV.');
      return;
    }

    monitorActive = true;
    var btn = document.getElementById('btn-monitor-live');
    if (btn) {
      btn.textContent = '⏹️ DETENER MONITOR';
      btn.style.background = 'linear-gradient(135deg,#cc3333,#aa2222)';
    }

    // Show monitor panel
    var panel = document.getElementById('monitor-panel');
    if (!panel) {
      panel = createMonitorPanel();
      var bottomBar = document.getElementById('tote-bottom-bar');
      if (bottomBar) bottomBar.appendChild(panel);
    }
    panel.style.display = 'block';

    // Auto-minimize CSV loader
    var csvContent = document.getElementById('tote-csv-content');
    var minBtn = document.getElementById('tote-minimize-btn');
    if (csvContent && minBtn) {
      csvContent.style.display = 'none';
      minBtn.textContent = '▲';
    }

    // Run first update immediately, then every 60s
    updateMonitor();
    monitorInterval = setInterval(updateMonitor, 60000);
  }

  function stopMonitor() {
    monitorActive = false;
    if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
    var btn = document.getElementById('btn-monitor-live');
    if (btn) {
      btn.textContent = '📊 MONITOR LIVE';
      btn.style.background = 'linear-gradient(135deg,#00875a,#006644)';
    }
    var panel = document.getElementById('monitor-panel');
    if (panel) panel.style.display = 'none';
  }

  function createMonitorPanel() {
    var panel = document.createElement('div');
    panel.id = 'monitor-panel';
    panel.style.cssText = 'padding:12px 16px;background:#0d1520;border-top:1px solid #1e2d40;max-height:50vh;overflow-y:auto;';
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
        '<span style="color:#36b37e;font-size:14px;font-weight:700;">📊 Monitor Live — Recepción en tiempo real</span>' +
        '<div style="display:flex;align-items:center;gap:10px;">' +
          '<span id="monitor-last-update" style="color:#8899aa;font-size:11px;"></span>' +
          '<span id="monitor-mini-summary" style="color:#ff9900;font-size:12px;font-weight:700;display:none;"></span>' +
          '<div id="monitor-minimize-btn" style="cursor:pointer;font-size:16px;color:#8899aa;user-select:none;" title="Minimizar/Expandir">▼</div>' +
        '</div>' +
      '</div>' +
      '<div id="monitor-body">' +
        '<div id="monitor-summary" style="display:flex;gap:16px;margin-bottom:10px;flex-wrap:wrap;"></div>' +
        '<div style="background:#1a2332;border-radius:8px;overflow:hidden;height:20px;margin-bottom:10px;">' +
          '<div id="monitor-progress-bar" style="height:100%;background:linear-gradient(90deg,#ff9900,#ffb84d);width:0%;transition:width 1s;border-radius:8px;"></div>' +
        '</div>' +
        '<div id="monitor-tote-list" style="max-height:35vh;overflow-y:auto;"></div>' +
      '</div>' +
      '';
    // Wire minimize toggle
    panel.querySelector('#monitor-minimize-btn').addEventListener('click', function () {
      var body = document.getElementById('monitor-body');
      var miniSummary = document.getElementById('monitor-mini-summary');
      var isHidden = body.style.display === 'none';
      body.style.display = isHidden ? 'block' : 'none';
      miniSummary.style.display = isHidden ? 'none' : 'inline';
      this.textContent = isHidden ? '▼' : '▲';
      this.title = isHidden ? 'Minimizar' : 'Expandir';
    });
    return panel;
  }

  function updateMonitor() {
    var allToteIds = Object.keys(state.toteData);
    if (allToteIds.length === 0) return;

    // Get transfer IDs
    var transferIds = {};
    for (var t = 0; t < allToteIds.length; t++) {
      var td = state.toteData[allToteIds[t]];
      if (td && td.transferId) transferIds[td.transferId] = true;
    }
    var transfers = Object.keys(transferIds);

    // Build FNSKU→totes map
    var fnskuToTotes = {};
    for (var t2 = 0; t2 < allToteIds.length; t2++) {
      var td2 = state.toteData[allToteIds[t2]];
      if (!td2) continue;
      for (var f = 0; f < td2.fnskus.length; f++) {
        var fk = td2.fnskus[f].fnsku;
        if (!fnskuToTotes[fk]) fnskuToTotes[fk] = [];
        fnskuToTotes[fk].push({ toteId: allToteIds[t2], qty: td2.fnskus[f].qty });
      }
    }

    // Query all transfers
    var monitorStatus = {};  // { toteId: { received, expected } }
    var chain = Promise.resolve();
    for (var tr = 0; tr < transfers.length; tr++) {
      chain = chain.then((function (trId) {
        return function () {
          return queryAllAuditPages({ scannableId: trId, adjustmentType: 'RECEIVE', pageSize: 100 })
            .then(function (items) {
              var rcvByFnsku = {};
              for (var i = 0; i < items.length; i++) {
                var sku = items[i].sku || '';
                rcvByFnsku[sku] = (rcvByFnsku[sku] || 0) + (items[i].quantity || 0);
              }
              for (var fnsku in rcvByFnsku) {
                var totes = fnskuToTotes[fnsku] || [];
                var remaining = rcvByFnsku[fnsku];
                for (var j = 0; j < totes.length && remaining > 0; j++) {
                  var tid = totes[j].toteId;
                  if (!monitorStatus[tid]) monitorStatus[tid] = { received: 0, expected: state.toteData[tid].totalQty };
                  var assign = Math.min(remaining, totes[j].qty);
                  monitorStatus[tid].received += assign;
                  remaining -= assign;
                }
              }
            });
        };
      })(transfers[tr]));
    }

    chain.then(function () {
      renderMonitor(monitorStatus, allToteIds);
    }).catch(function (err) {
      console.error('[Monitor] Error:', err);
    });
  }

  function renderMonitor(monitorStatus, allToteIds) {
    var now = new Date();
    var timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0') + ':' + now.getSeconds().toString().padStart(2, '0');

    // Calculate totals
    var totalExpected = 0, totalReceived = 0;
    var complete = 0, incomplete = 0, notStarted = 0;
    for (var t = 0; t < allToteIds.length; t++) {
      var tid = allToteIds[t];
      var exp = state.toteData[tid] ? state.toteData[tid].totalQty : 0;
      var rcv = monitorStatus[tid] ? monitorStatus[tid].received : 0;
      totalExpected += exp;
      totalReceived += rcv;
      if (rcv === 0) notStarted++;
      else if (rcv >= exp) complete++;
      else incomplete++;
    }
    var pct = totalExpected > 0 ? Math.round(totalReceived / totalExpected * 100) : 0;

    // Update summary
    var summary = document.getElementById('monitor-summary');
    if (summary) {
      summary.innerHTML =
        '<div style="background:#1a2332;padding:8px 14px;border-radius:8px;text-align:center;">' +
          '<div style="color:#8899aa;font-size:10px;">RECIBIDAS</div>' +
          '<div style="color:#ff9900;font-size:20px;font-weight:700;">' + totalReceived + '/' + totalExpected + '</div>' +
        '</div>' +
        '<div style="background:#1a2332;padding:8px 14px;border-radius:8px;text-align:center;">' +
          '<div style="color:#8899aa;font-size:10px;">PROGRESO</div>' +
          '<div style="color:#36b37e;font-size:20px;font-weight:700;">' + pct + '%</div>' +
        '</div>' +
        '<div style="background:#1a2332;padding:8px 14px;border-radius:8px;text-align:center;">' +
          '<div style="color:#8899aa;font-size:10px;">TOTES</div>' +
          '<div style="font-size:12px;">' +
            '<span style="color:#36b37e;">✅' + complete + '</span> ' +
            '<span style="color:#ffb84d;">⚠️' + incomplete + '</span> ' +
            '<span style="color:#ff4444;">❌' + notStarted + '</span>' +
          '</div>' +
        '</div>';
    }

    // Update progress bar
    var bar = document.getElementById('monitor-progress-bar');
    if (bar) bar.style.width = pct + '%';

    // Update timestamp
    var lastUpdate = document.getElementById('monitor-last-update');
    if (lastUpdate) lastUpdate.textContent = '🔄 ' + timeStr + ' (cada 60s)';

    // Update mini summary (shown when minimized)
    var miniSummary = document.getElementById('monitor-mini-summary');
    if (miniSummary) miniSummary.textContent = totalReceived + '/' + totalExpected + ' (' + pct + '%) — ✅' + complete + ' ⚠️' + incomplete + ' ❌' + notStarted;

    // Render tote list — incomplete first
    var sorted = allToteIds.slice().sort(function (a, b) {
      var ra = monitorStatus[a] ? monitorStatus[a].received : 0;
      var rb = monitorStatus[b] ? monitorStatus[b].received : 0;
      var ea = state.toteData[a] ? state.toteData[a].totalQty : 0;
      var eb = state.toteData[b] ? state.toteData[b].totalQty : 0;
      function ord(r, e) { return r > 0 && r < e ? 0 : (r === 0 ? 1 : 2); }
      return ord(ra, ea) - ord(rb, eb);
    });

    var listDiv = document.getElementById('monitor-tote-list');
    if (!listDiv) return;
    var html = '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
    html += '<tr style="color:#8899aa;border-bottom:1px solid #1e2d40;"><th style="text-align:left;padding:4px;">Tote</th><th>Esperadas</th><th>Recibidas</th><th>Pendientes</th><th style="width:120px;">Progreso</th></tr>';

    for (var i = 0; i < sorted.length; i++) {
      var sid = sorted[i];
      var exp = state.toteData[sid] ? state.toteData[sid].totalQty : 0;
      var rcv = monitorStatus[sid] ? monitorStatus[sid].received : 0;
      var pend = Math.max(0, exp - rcv);
      var tpct = exp > 0 ? Math.round(rcv / exp * 100) : 0;
      var color = rcv === 0 ? '#ff4444' : (rcv >= exp ? '#36b37e' : '#ffb84d');
      html += '<tr style="border-bottom:1px solid #0f1a28;color:#ccc;">' +
        '<td style="padding:3px 4px;font-weight:600;">' + sid + '</td>' +
        '<td style="text-align:center;">' + exp + '</td>' +
        '<td style="text-align:center;color:' + color + ';font-weight:700;">' + rcv + '</td>' +
        '<td style="text-align:center;">' + pend + '</td>' +
        '<td><div style="background:#1a2332;border-radius:4px;overflow:hidden;height:14px;">' +
          '<div style="height:100%;width:' + tpct + '%;background:' + color + ';border-radius:4px;transition:width 1s;"></div>' +
        '</div></td></tr>';
    }
    html += '</table>';
    listDiv.innerHTML = html;
  }

  // =========================================================
  // DETECTAR TOTE DESDE LA URL
  // La pantalla receiveProduct trae ?shipmentId=...&toteId=...
  // =========================================================
  function detectToteFromURL() {
    try {
      var params = new URLSearchParams(window.location.search);
      var urlToteId = params.get('toteId');
      if (urlToteId && urlToteId.length > 3 && !state.active) {
        console.log('[ToteProgress] Tote detectado en URL: ' + urlToteId);
        state.lastContainerValue = urlToteId;
        // Pequeño delay para que el panel esté listo
        setTimeout(function () {
          onToteScanned(urlToteId);
        }, 300);
      }
    } catch (e) {
      console.warn('[ToteProgress] Error leyendo URL:', e);
    }
  }

  // =========================================================
  // START
  // =========================================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
