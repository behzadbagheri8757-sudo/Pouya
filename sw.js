// sw.js — کش‌کردن اپ برای اجرای کامل آفلاین (بدون نیاز به سرور/CDN)
const CACHE = 'dia-business-v2-14-phase4-invoicepatch';
const ASSETS = [
  './', './index.html', './manifest.json',
  './css/style.css', './css/print.css',
  './js/app.js', './js/dashboard-metrics.js', './js/db.js', './js/utils.js', './js/invoice-engine.js', './js/finance.js', './js/inventory.js', './js/router.js', './js/validators.js', './js/components.js',
  './js/views/dashboard.js', './js/views/customers.js', './js/views/customer-detail.js',
  './js/views/products.js', './js/views/services.js', './js/views/projects.js',
  './js/views/invoices.js', './js/views/accounting.js', './js/views/reports.js', './js/views/settings.js', './js/views/payment-modal.js', './js/views/stock-modal.js',
  './assets/icon-192.png', './assets/icon-512.png', './assets/icon-maskable-512.png', './assets/apple-touch-icon.png', './assets/fonts/NotoKufiArabic-Regular.ttf', './assets/fonts/NotoKufiArabic-Bold.ttf', './assets/icons/search.svg', './assets/icons/plus.svg', './assets/icons/users.svg', './assets/icons/more-vertical.svg', './assets/icons/briefcase.svg', './assets/icons/settings.svg', './assets/icons/box.svg', './assets/icons/printer.svg', './assets/icons/file-plus.svg', './assets/icons/image.svg', './assets/icons/chevron-down.svg', './assets/icons/edit.svg', './assets/icons/check.svg', './assets/icons/file-text.svg', './assets/icons/box-plus.svg', './assets/icons/arrow-right.svg', './assets/icons/trash.svg', './assets/icons/download.svg', './assets/icons/home.svg', './assets/icons/more.svg', './assets/icons/wallet.svg', './assets/icons/upload.svg', './assets/icons/x.svg', './assets/icons/folder.svg', './assets/icons/chart.svg', './assets/icons/chevron-left.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => cached || caches.match('./index.html'));
      // اگر نسخه کش‌شده موجود است فوراً همان را بده (سریع و آفلاین-امن)، وگرنه منتظر شبکه بمان
      return cached || network;
    })
  );
});
