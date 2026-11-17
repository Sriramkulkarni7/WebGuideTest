// ShopLite: plain JavaScript, no framework, no build step.

const PRODUCTS = [
  { id: 'lamp',     name: 'Brass Desk Lamp',    price: 1899, image: 'img/lamp.svg',     description: 'Adjustable brass lamp with a warm LED bulb.' },
  { id: 'mug',      name: 'Stoneware Mug',      price: 449,  image: 'img/mug.svg',      description: 'Hand-glazed 350 ml mug, microwave safe.' },
  { id: 'notebook', name: 'Dot Grid Notebook',  price: 299,  image: 'img/notebook.svg', description: 'A5, 160 pages of 100 gsm paper.' },
  { id: 'plant',    name: 'Snake Plant',        price: 649,  image: 'img/plant.svg',    description: 'Low-maintenance plant in a ceramic pot.' },
  { id: 'bottle',   name: 'Steel Water Bottle', price: 799,  image: 'img/bottle.svg',   description: 'Keeps drinks cold for 24 hours, 750 ml.' },
  { id: 'cushion',  name: 'Cotton Cushion',     price: 999,  image: 'img/cushion.svg',  description: 'Block-printed cover with a soft fill, 45 × 45 cm.' },
];

const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const byId = (id) => document.getElementById(id);

/** cart: Map<productId, quantity> */
const cart = new Map();
let quickViewProduct = null;

// ---------- Product grid ----------
function renderProducts() {
  const grid = byId('product-grid');
  const template = byId('product-card-template');
  const fragment = document.createDocumentFragment();

  PRODUCTS.forEach((product, index) => {
    const item = template.content.cloneNode(true);
    const li = item.querySelector('li');
    const img = item.querySelector('img');
    li.dataset.id = product.id;
    li.dataset.name = product.name.toLowerCase();
    img.src = product.image;
    img.alt = product.name;
    // First row is likely in the initial viewport; lazy-load the rest.
    if (index >= 3) img.loading = 'lazy';
    item.querySelector('h3').textContent = product.name;
    item.querySelector('.price').textContent = rupees.format(product.price);
    item.querySelector('.quick-view').setAttribute('aria-label', `Quick view: ${product.name}`);
    item.querySelector('.add-to-cart').setAttribute('aria-label', `Add ${product.name} to cart`);
    fragment.append(item);
  });

  grid.append(fragment);

  grid.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const product = PRODUCTS.find((p) => p.id === button.closest('li').dataset.id);
    if (button.classList.contains('add-to-cart')) addToCart(product);
    if (button.classList.contains('quick-view')) openQuickView(product);
  });
}

// ---------- Search ----------
function setupSearch() {
  const input = byId('search-input');
  input.addEventListener('input', () => {
    const term = input.value.trim().toLowerCase();
    let visible = 0;
    for (const li of byId('product-grid').children) {
      const match = li.dataset.name.includes(term);
      li.hidden = !match;
      if (match) visible++;
    }
    byId('no-results').hidden = visible > 0;
  });
}

// ---------- Cart ----------
function addToCart(product) {
  cart.set(product.id, (cart.get(product.id) ?? 0) + 1);
  renderCart();
  toast(`${product.name} added to cart`);
}

function removeFromCart(productId) {
  cart.delete(productId);
  renderCart();
}

function cartTotals() {
  let count = 0;
  let total = 0;
  for (const [id, qty] of cart) {
    const product = PRODUCTS.find((p) => p.id === id);
    count += qty;
    total += product.price * qty;
  }
  return { count, total };
}

function renderCart() {
  const { count, total } = cartTotals();
  const list = byId('cart-items');
  list.replaceChildren();

  for (const [id, qty] of cart) {
    const product = PRODUCTS.find((p) => p.id === id);
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = `${product.name} × ${qty}`;
    const price = document.createElement('span');
    price.textContent = rupees.format(product.price * qty);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${product.name} from cart`);
    remove.addEventListener('click', () => removeFromCart(id));
    li.append(name, price, remove);
    list.append(li);
  }

  byId('cart-empty').hidden = count > 0;
  byId('go-checkout').disabled = count === 0;
  byId('cart-count').textContent = count;
  byId('cart-total').textContent = rupees.format(total);
  byId('checkout-total').textContent = rupees.format(total);
  byId('cart-summary').textContent = `${count} ${count === 1 ? 'item' : 'items'}, ${rupees.format(total)}`;
}

// ---------- Dialogs ----------
function openQuickView(product) {
  quickViewProduct = product;
  const img = byId('qv-image');
  img.src = product.image;
  img.alt = product.name;
  byId('qv-title').textContent = product.name;
  byId('qv-description').textContent = product.description;
  byId('qv-price').textContent = rupees.format(product.price);
  byId('quick-view').showModal();
}

function setupDialogs() {
  const quickView = byId('quick-view');
  const cartDialog = byId('cart');
  const checkout = byId('checkout');

  quickView.addEventListener('close', () => {
    if (quickView.returnValue === 'add' && quickViewProduct) addToCart(quickViewProduct);
    quickView.returnValue = '';
  });

  // The cart button opens declaratively (command="show-modal"). Invoker Commands is only
  // Baseline Newly available, so wire up the same behaviour where it is missing.
  if (!('commandForElement' in HTMLButtonElement.prototype)) {
    for (const button of document.querySelectorAll('button[command="show-modal"][commandfor]')) {
      button.addEventListener('click', () => byId(button.getAttribute('commandfor'))?.showModal());
    }
  }

  cartDialog.addEventListener('close', () => {
    if (cartDialog.returnValue === 'checkout' && cart.size > 0) checkout.showModal();
    cartDialog.returnValue = '';
  });

  byId('cancel-checkout').addEventListener('click', () => checkout.close());

  // Native constraint validation runs before 'submit' fires, so this only sees valid data.
  byId('checkout-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = new FormData(event.target).get('fullname');
    cart.clear();
    renderCart();
    event.target.reset();
    checkout.close();
    toast(`Thank you, ${name}! Your order is placed.`);
  });

  // Light-dismiss fallback where <dialog closedby> is unsupported (Safari).
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    const outside = (e, dialog) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
      let pressedOutside = false;
      dialog.addEventListener('pointerdown', (e) => { pressedOutside = outside(e, dialog); });
      dialog.addEventListener('pointerup', (e) => { if (pressedOutside && outside(e, dialog)) dialog.close(); });
    }
  }
}

// ---------- Toast ----------
let toastTimer;
function toast(message) {
  const el = byId('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

renderProducts();
setupSearch();
setupDialogs();
renderCart();

// Newsletter signup
function subscribe() {
  var email = document.getElementById('nl-email').value;
  if (email.indexOf('@') == -1) {
    alert('Please enter a valid email');
    return;
  }
  document.getElementById('nl-msg').style.display = 'block';
}
