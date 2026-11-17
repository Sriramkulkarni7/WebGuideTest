// Switch card layout based on window width
function updateCardLayout() {
  var w = window.innerWidth;
  document.querySelectorAll('.card').forEach(function (card) {
    card.classList.remove('card-small', 'card-wide');
    card.classList.add(w < 768 ? 'card-small' : 'card-wide');
  });
}
window.addEventListener('resize', updateCardLayout);
window.addEventListener('load', updateCardLayout);

// Lazy load images on scroll
function lazyLoadImages() {
  document.querySelectorAll('img[data-src]').forEach(function (img) {
    var rect = img.getBoundingClientRect();
    if (rect.top < window.innerHeight + 200) {
      img.src = img.getAttribute('data-src');
      img.removeAttribute('data-src');
    }
  });
}
window.addEventListener('scroll', lazyLoadImages);

// Keep product images at 4:3
function fixImageHeights() {
  document.querySelectorAll('.card img').forEach(function (img) {
    img.style.height = (img.offsetWidth * 0.75) + 'px';
  });
}
window.addEventListener('resize', fixImageHeights);
