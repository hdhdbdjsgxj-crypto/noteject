(() => {
  'use strict';
  const t = source => window.NotejectI18n?.t?.(source) || source;
  let releaseConfig = null;
  const downloadPlatforms = ['windows', 'android', 'macArm64', 'macX64', 'ios'];
  const refreshDownloadLabels = () => {
    if (!releaseConfig) return;
    for (const platform of downloadPlatforms) {
      const link = document.querySelector(`[data-download="${platform}"]`), status = document.querySelector(`[data-download-status="${platform}"]`);
      if (!link?.dataset.releaseAvailable) continue;
      const mac = platform.startsWith('mac'), ios = platform === 'ios';
      const label = ios ? t('Download unsigned IPA') : mac ? t('Download development build') : t(platform === 'windows' ? 'Download for Windows' : 'Download for Android');
      link.innerHTML = `${label} <span aria-hidden="true">↓</span>`;
      if (status) {
        // This compound label is already translated here and refreshed on each
        // locale change. Reprocessing it as English can reinterpret a French
        // "Version non signée" as the "Version {version}" template.
        status.setAttribute('data-i18n-ignore', '');
        status.textContent = ios || mac
          ? `${t(ios ? 'Unsigned build' : 'Development build')}${releaseConfig.versions?.[platform] ? ` · ${t('Version')} ${releaseConfig.versions[platform]}` : ''}`
          : releaseConfig.versions?.[platform] ? `${t('Version')} ${releaseConfig.versions[platform]}` : t('Latest release');
      }
    }
  };
  document.addEventListener('noteject:languagechange', refreshDownloadLabels);
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  const header = document.querySelector('.site-header');
  const menuToggle = header?.querySelector('.menu-toggle');
  const mainNav = header?.querySelector('#main-nav');
  const setMenuOpen = open => {
    header?.classList.toggle('menu-open', open);
    menuToggle?.setAttribute('aria-expanded', String(open));
    menuToggle?.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  };
  menuToggle?.addEventListener('click', () => setMenuOpen(menuToggle.getAttribute('aria-expanded') !== 'true'));
  mainNav?.addEventListener('click', event => {
    if (event.target.closest('a')) setMenuOpen(false);
  });
  document.addEventListener('pointerdown', event => {
    if (header?.classList.contains('menu-open') && !header.contains(event.target)) setMenuOpen(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && header?.classList.contains('menu-open')) {
      setMenuOpen(false);
      menuToggle?.focus();
    }
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 1024) setMenuOpen(false);
  }, { passive: true });

  const magneticMode = window.matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)');
  if (magneticMode.matches) {
    document.querySelectorAll('[data-magnetic]').forEach(item => {
      item.addEventListener('pointermove', event => {
        if (event.pointerType === 'touch') return;
        const box = item.getBoundingClientRect();
        const dx = Math.max(-5, Math.min(5, (event.clientX - box.left - box.width / 2) * .12));
        const dy = Math.max(-4, Math.min(4, (event.clientY - box.top - box.height / 2) * .14));
        item.style.setProperty('--magnetic-x', `${dx.toFixed(1)}px`);
        item.style.setProperty('--magnetic-y', `${dy.toFixed(1)}px`);
      });
      item.addEventListener('pointerleave', () => {
        item.style.setProperty('--magnetic-x', '0px');
        item.style.setProperty('--magnetic-y', '0px');
      });
    });
  }

  fetch('/api/site-config', { cache: 'no-store' }).then(response => response.ok ? response.json() : null).then(config => {
    if (!config) return;
    releaseConfig = config;
    for (const platform of downloadPlatforms) {
      const link = document.querySelector(`[data-download="${platform}"]`), status = document.querySelector(`[data-download-status="${platform}"]`);
      if (!link) continue;
      const url = config.downloads?.[platform];
      try {
        const safe = new URL(url);
        if (!['https:'].includes(safe.protocol)) throw new Error('Unsafe download URL');
        link.href = safe.href; link.removeAttribute('aria-disabled'); link.setAttribute('rel', 'noopener');
        link.dataset.releaseAvailable = 'true';
      } catch { /* Release hosting is configured after the build artifacts are uploaded. */ }
    }
    refreshDownloadLabels();
  }).catch(() => {});
})();
