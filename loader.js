/* =========================================================
   FAAST Tote Progress - LOADER v2.2
   
   Este archivo se instala UNA VEZ en la TC57 y NO se toca más.
   Descarga el content.js desde GitHub cada vez que se abre FAAST.
   
   CONFIGURACIÓN:
   1. Crea un repo en GitHub (público o privado)
   2. Sube content.js al repo
   3. Cambia GITHUB_USER, GITHUB_REPO y GITHUB_BRANCH abajo
   4. Si el repo es privado, genera un Personal Access Token
      y ponlo en GITHUB_TOKEN
   
   CÓMO SUBIR/ACTUALIZAR content.js:
   - Desde el navegador: github.com → tu repo → content.js → Edit → Commit
   - Desde git: editas en tu PC, git commit, git push
   - La TC57 descarga la nueva versión al recargar FAAST
   ========================================================= */

(function () {
  'use strict';

  // ======================================
  // ⚙️ CONFIGURACIÓN - EDITAR AQUÍ
  // ======================================

  // Tu usuario de GitHub
  var GITHUB_USER = 'pssegovi';

  // Nombre del repositorio
  var GITHUB_REPO = 'faast-tote-progress';

  // Rama (normalmente 'main')
  var GITHUB_BRANCH = 'main';

  // Archivo a descargar
  var SCRIPT_FILE = 'content.js';

  // Token de acceso (solo si el repo es PRIVADO)
  // Crear en: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
  // Permisos: Contents → Read-only
  // Dejar vacío '' si el repo es público
  var GITHUB_TOKEN = '';

  // ======================================
  // NO TOCAR DEBAJO DE AQUÍ
  // ======================================

  var rawUrl = 'https://raw.githubusercontent.com/' +
    GITHUB_USER + '/' + GITHUB_REPO + '/' + GITHUB_BRANCH + '/' + SCRIPT_FILE +
    '?t=' + Date.now(); // cache-busting

  var fetchOptions = {};
  if (GITHUB_TOKEN) {
    fetchOptions.headers = {
      'Authorization': 'token ' + GITHUB_TOKEN
    };
  }

  console.log('[ToteProgress Loader] Descargando desde GitHub...');

  fetch(rawUrl, fetchOptions)
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.text();
    })
    .then(function (code) {
      console.log('[ToteProgress Loader] ✅ Descargado (' + code.length + ' bytes)');

      // Guardar en cache para uso offline
      try { localStorage.setItem('toteProgress_cachedCode', code); } catch (e) {}

      // Inyectar y ejecutar
      var script = document.createElement('script');
      script.textContent = code;
      document.head.appendChild(script);

      console.log('[ToteProgress Loader] ✅ content.js inyectado');
    })
    .catch(function (error) {
      console.warn('[ToteProgress Loader] ⚠️ Error GitHub: ' + error.message);
      console.warn('[ToteProgress Loader] Intentando versión cacheada...');

      // FALLBACK: usar última versión cacheada
      var cachedCode = localStorage.getItem('toteProgress_cachedCode');
      if (cachedCode) {
        console.log('[ToteProgress Loader] 📦 Usando versión cacheada');
        var script = document.createElement('script');
        script.textContent = cachedCode;
        document.head.appendChild(script);
      } else {
        // Sin cache, sin conexión = mostrar error
        var msg = document.createElement('div');
        msg.style.cssText = 'position:fixed;top:10px;right:10px;padding:12px 16px;background:#ff5630;color:#fff;border-radius:8px;font-size:13px;font-weight:600;z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:300px;';
        msg.innerHTML = '⚠️ Tote Progress: Sin conexión<br><small style="font-weight:400;">No se pudo descargar de GitHub ni hay versión cacheada</small>';
        document.body.appendChild(msg);
        setTimeout(function () {
          msg.style.opacity = '0';
          msg.style.transition = 'opacity 0.5s';
          setTimeout(function () { msg.remove(); }, 500);
        }, 10000);
      }
    });
})();
