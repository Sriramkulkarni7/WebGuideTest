// Festive sale popup
(function () {
  var overlay = document.createElement('div');
  overlay.className = 'promo-overlay';
  overlay.innerHTML =
    '<div class="promo-box">' +
    '  <img src="img/lamp.svg">' +
    '  <div class="promo-title">Diwali Sale - 30% off!</div>' +
    '  <span class="promo-close" onclick="closePromo()">X</span>' +
    '</div>';
  document.body.appendChild(overlay);

  window.openPromo = function () {
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    overlay.querySelector('.promo-close').focus();
  };

  window.closePromo = function () {
    overlay.style.display = 'none';
    document.body.style.overflow = 'auto';
  };

  document.addEventListener('keydown', function (e) {
    if (e.keyCode === 27) closePromo();
  });

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closePromo();
  });

  setTimeout(openPromo, 1500);
})();
