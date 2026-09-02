/* =========================================================
   FAAST Tote Progress Extension v2.0
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
    VERSION: '2.0'
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
    var colScannable = -1, colFnsku = -1, colQty = -1;

    for (var h = 0; h < header.length; h++) {
      var col = header[h].trim().toLowerCase();
      if (col === 'scannable id') colScannable = h;
      else if (col === 'fn sku' || col === 'fnsku') colFnsku = h;
      else if (col === 'quantity') colQty = h;
    }

    if (colScannable === -1 || colQty === -1) {
      alert('⚠️ CSV no válido.\n\nColumnas requeridas:\n- "Scannable ID"\n- "Quantity"\n\nColumnas encontradas:\n' + header.join(', '));
      return {};
    }

    // Parsear filas y agrupar por tote
    var toteData = {};
    for (var i = 1; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;

      var fields = parseCSVLine(line);
      var toteId = (fields[colScannable] || '').trim();
      var fnsku = colFnsku >= 0 ? (fields[colFnsku] || '').trim() : '';
      var qty = parseInt(fields[colQty]) || 0;

      if (!toteId || qty === 0) continue;

      if (!toteData[toteId]) {
        toteData[toteId] = { totalQty: 0, fnskus: [] };
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
    }

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
    panel.style.cssText = 'margin:12px 0;padding:14px 16px;background:#1a2332;border-radius:10px;border:2px solid #ff9900;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.3);';
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
        '<div style="font-size:15px;font-weight:700;color:#ff9900;">📄 Cargar Lista de Totes</div>' +
        '<div id="csv-status" style="font-size:11px;color:#8899aa;"></div>' +
      '</div>' +
      '<div style="font-size:12px;color:#8899aa;margin-bottom:10px;">Sube el archivo <strong style="color:#ffb84d;">shipmentItemList.csv</strong> para conocer las unidades de cada tote</div>' +
      '<div style="display:flex;gap:8px;align-items:center;">' +
        '<label for="csv-file-input" style="flex:1;padding:12px;background:rgba(255,255,255,0.06);border:2px dashed rgba(255,153,0,0.5);border-radius:8px;text-align:center;cursor:pointer;font-size:13px;font-weight:600;color:#ff9900;transition:all 0.15s;">' +
          '📁 SELECCIONAR CSV' +
          '<input type="file" id="csv-file-input" accept=".csv,.txt" style="display:none;">' +
        '</label>' +
      '</div>' +
      '<div id="csv-tote-count" style="display:none;margin-top:10px;padding:8px 12px;background:rgba(54,179,126,0.15);border:1px solid rgba(54,179,126,0.4);border-radius:8px;text-align:center;font-size:13px;font-weight:600;color:#57d9a3;"></div>';
    return panel;
  }

  function createSetupPanel() {
    var panel = document.createElement('div');
    panel.id = 'tote-setup-panel';
    panel.style.cssText = 'display:none;margin:12px 0;padding:14px 16px;background:#1a2332;border-radius:10px;border:2px solid #ff9900;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.3);';
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
    widget.style.cssText = 'display:none;margin:12px 0;padding:14px 16px;background:#1a2332;border-radius:10px;border:2px solid #ff9900;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.3);position:relative;';
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
    // Hide CSV loader while showing setup
    var csvLoader = document.getElementById('tote-csv-loader');
    if (csvLoader) csvLoader.style.display = 'none';
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
          findContainerInput()) {
        clearInterval(checkPage);
        injectUI();
      }
    }, 500);

    setTimeout(function () { clearInterval(checkPage); }, 30000);
  }

  function injectUI() {
    if (document.getElementById('tote-csv-loader')) return;

    var insertionPoint = findInsertionPoint();
    if (!insertionPoint) {
      console.log('[ToteProgress] No insertion point found');
      return;
    }

    // Create elements
    var csvLoader = createCSVLoader();
    var setupPanel = createSetupPanel();
    var progressWidget = createProgressWidget();
    var summaryOverlay = createSummaryOverlay();

    // Insert in DOM
    var parent = insertionPoint.parentNode;
    parent.insertBefore(csvLoader, insertionPoint.nextSibling);
    parent.insertBefore(setupPanel, csvLoader.nextSibling);
    parent.insertBefore(progressWidget, setupPanel.nextSibling);
    document.body.appendChild(summaryOverlay);

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
    }

    // Event listeners
    document.getElementById('btn-finalizar-tote').addEventListener('click', finalizarTote);
    document.getElementById('btn-reset-tote').addEventListener('click', function () {
      if (confirm('¿Resetear el progreso de este tote?')) resetTote();
    });
    document.getElementById('btn-cerrar-resumen').addEventListener('click', resetTote);

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

    console.log('[ToteProgress] Extension v' + CONFIG.VERSION + ' injected (' + 
      (state.csvLoaded ? Object.keys(state.toteData).length + ' totes loaded' : 'no CSV') + ')');
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
