(async () => {
  'use strict';
  const book = document.querySelector('#book');
  const status = document.querySelector('#book-status');
  const retry = document.querySelector('#retry-book');
  status.textContent = 'Opening the book…';
  book.setAttribute('aria-busy', 'true');
  try {
    // Promise.all preserves numbered page order even when requests finish out of order.
    const pages = await Promise.all(Array.from({ length: 18 }, async (_, index) => {
      const url = `pages/page${index + 1}.html`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Unable to load ${url}: ${response.status}`);
      const html = await response.text();
      if (!html.trim()) throw new Error(`Empty book page: ${url}`);
      return html;
    }));
    // Insert once, only after every page has loaded. Never initialize a partial book.
    book.innerHTML = pages.join('\n');
    status.hidden = true;
  } catch (error) {
    status.textContent = window.location.protocol === 'file:'
      ? 'Open this site through a local web server to load the book.'
      : 'The book could not load. Please check your connection and try again.';
    retry.hidden = false;
    book.setAttribute('aria-busy', 'false');
    console.error(error);
    return;
  }
  book.setAttribute('aria-busy', 'false');
  const $ = window.jQuery;
  if (!$?.fn?.turn) return; // Loaded pages remain readable if a vendor script fails.
  const shell = document.querySelector('.book-shell');
  const $book = $(book);
  // Turn.js detaches off-screen pages; retain references for labels and measurement.
  const faces = [...book.querySelectorAll('.face')];
  const previous = document.querySelector('#previous');
  const next = document.querySelector('#next');
  const mobileQuery = window.matchMedia('(max-width: 960px)');
  const portraitQuery = window.matchMedia('(orientation: portrait)');
  const landscapeReaderQuery = window.matchMedia('(orientation: landscape) and (max-width: 960px), (orientation: landscape) and (hover: none) and (pointer: coarse)');
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const dialog = document.querySelector('#image-dialog');
  let imageTrigger = null;
  let resizeFrame = 0;
  let restoringHistory = false;
  let printBook = null;
  const imageViewport = document.querySelector('.dialog-image-scroll');
  const imageCanvas = document.querySelector('.image-canvas');
  const enlargedImage = document.querySelector('#enlarged-image');
  const zoomIn = document.querySelector('#zoom-in');
  const zoomOut = document.querySelector('#zoom-out');
  const zoomFit = document.querySelector('#zoom-fit');
  const viewer = { width: 0, height: 0, zoom: 1, renderedWidth: 0, renderedHeight: 0 };
  let imagePan = null;

  function renderViewer() {
    if (!dialog.open || !viewer.width || !viewer.height) return;
    const width = imageViewport.clientWidth;
    const height = imageViewport.clientHeight;
    if (!width || !height) return;
    // Preserve the image point at the centre when changing magnification.
    const x = viewer.renderedWidth ? (imageViewport.scrollLeft + width / 2 - Math.max(0, (width - viewer.renderedWidth) / 2)) / viewer.renderedWidth : 0.5;
    const y = viewer.renderedHeight ? (imageViewport.scrollTop + height / 2 - Math.max(0, (height - viewer.renderedHeight) / 2)) / viewer.renderedHeight : 0.5;
    const scale = Math.min(width / viewer.width, height / viewer.height, 1) * viewer.zoom;
    viewer.renderedWidth = viewer.width * scale;
    viewer.renderedHeight = viewer.height * scale;
    enlargedImage.style.width = viewer.renderedWidth + 'px';
    enlargedImage.style.height = viewer.renderedHeight + 'px';
    imageCanvas.style.width = Math.max(width, viewer.renderedWidth) + 'px';
    imageCanvas.style.height = Math.max(height, viewer.renderedHeight) + 'px';
    imageViewport.scrollTo(
      Math.max(0, Math.min(viewer.renderedWidth - width, x * viewer.renderedWidth - width / 2)),
      Math.max(0, Math.min(viewer.renderedHeight - height, y * viewer.renderedHeight - height / 2))
    );
    imageViewport.classList.toggle('is-zoomed', viewer.zoom > 1);
    zoomOut.disabled = zoomFit.disabled = viewer.zoom === 1;
    zoomIn.disabled = viewer.zoom === 6;
  }

  function setViewerZoom(value) {
    viewer.zoom = Math.max(1, Math.min(6, value));
    renderViewer();
  }

  zoomIn.addEventListener('click', () => setViewerZoom(viewer.zoom * 1.5));
  zoomOut.addEventListener('click', () => setViewerZoom(viewer.zoom / 1.5));
  zoomFit.addEventListener('click', () => setViewerZoom(1));
  imageViewport.addEventListener('dblclick', event => {
    event.preventDefault();
    setViewerZoom(viewer.zoom === 1 ? 2 : 1);
  });
  imageViewport.addEventListener('pointerdown', event => {
    // Touch keeps native scrolling and browser pinch zoom; mouse users can drag.
    if (event.pointerType !== 'mouse' || event.button !== 0 || viewer.zoom === 1) return;
    imagePan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: imageViewport.scrollLeft, top: imageViewport.scrollTop };
    imageViewport.setPointerCapture(event.pointerId);
    imageViewport.classList.add('is-dragging');
    event.preventDefault();
  });
  imageViewport.addEventListener('pointermove', event => {
    if (!imagePan || imagePan.id !== event.pointerId) return;
    imageViewport.scrollTo(imagePan.left + imagePan.x - event.clientX, imagePan.top + imagePan.y - event.clientY);
  });
  function endImagePan() {
    imagePan = null;
    imageViewport.classList.remove('is-dragging');
  }
  imageViewport.addEventListener('pointerup', endImagePan);
  imageViewport.addEventListener('pointercancel', endImagePan);
  imageViewport.addEventListener('lostpointercapture', endImagePan);
  dialog.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (['+', '=', '-', '0'].includes(event.key)) {
      event.preventDefault();
      setViewerZoom(event.key === '0' ? 1 : event.key === '-' ? viewer.zoom / 1.5 : viewer.zoom * 1.5);
    }
  });

  function copyFace(face) {
    const copy = face.cloneNode(true);
    [copy, ...copy.querySelectorAll('[id]')].forEach(node => node.removeAttribute('id'));
    copy.removeAttribute('aria-hidden');
    copy.inert = false;
    return copy;
  }

  // Measure complete pages before fitting the mobile spread to the viewport.
  function dimensions() {
    const fitLandscape = landscapeReaderQuery.matches;
    shell.style.removeProperty('width');
    const availableWidth = Math.floor(shell.getBoundingClientRect().width);
    const width = fitLandscape ? 1080 : availableWidth;
    const measure = document.createElement('div');
    measure.className = 'page-measure';
    measure.inert = true;
    measure.setAttribute('aria-hidden', 'true');
    measure.style.width = (width / 2) + 'px';
    const copies = faces.filter(face => !face.classList.contains('cover')).map(copyFace);
    measure.append(...copies);
    document.body.append(measure);
    const minimum = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--book-height'));
    const height = Math.ceil(Math.max(minimum, ...copies.map(copy => copy.getBoundingClientRect().height)));
    measure.remove();
    if (fitLandscape) {
      const availableHeight = document.querySelector('.book-stage').clientHeight;
      const scale = Math.min(availableWidth / width, availableHeight / height);
      book.style.setProperty('--page-width', (width / 2) + 'px');
      book.style.setProperty('--page-height', height + 'px');
      book.style.setProperty('--page-scale', scale);
      shell.style.width = (width * scale) + 'px';
      return { width: width * scale, height: height * scale };
    }
    book.style.removeProperty('--page-width');
    book.style.removeProperty('--page-height');
    book.style.removeProperty('--page-scale');
    return { width, height };
  }

  function syncReader(page = $book.turn('page'), view = $book.turn('view'), announce = true) {
    const visible = view.filter(number => number > 0);
    const focusedFace = document.activeElement?.closest('.face');
    if (focusedFace && !visible.includes(faces.indexOf(focusedFace) + 1)) book.focus({ preventScroll: true });
    faces.forEach((face, index) => {
      const active = visible.includes(index + 1);
      face.inert = !active;
      face.setAttribute('aria-hidden', String(!active));
    });
    const first = page === 1;
    const last = page === faces.length;
    const chapter = faces[page - 1].dataset.chapter;
    const numbers = visible.map(number => String(number - 1).padStart(2, '0')).join('–');
    const label = first || last ? chapter : chapter + ' · ' + numbers + ' / 16';
    book.setAttribute('aria-busy', 'false');
    previous.disabled = first;
    next.disabled = last;
    previous.setAttribute('aria-label', visible.includes(2) ? 'Close the front cover' : 'Previous page');
    const nextText = first ? 'Open the book' : visible.includes(17) ? 'Close the book' : 'Next';
    document.querySelector('#next-label').textContent = nextText;
    next.setAttribute('aria-label', nextText === 'Next' ? 'Next page' : nextText);
    document.querySelector('#position-label').textContent = label;
    document.querySelector('#reading-progress').style.width = ((page - 1) / (faces.length - 1) * 100) + '%';
    document.querySelectorAll('.chapter-nav [data-page]').forEach(link => {
      if (faces[Number(link.dataset.page) - 1].dataset.chapter === chapter) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
    if (announce) document.querySelector('#announcement').textContent = label + '. ' + faces[page - 1].getAttribute('aria-label') + '.';
  }

  document.documentElement.classList.add('js');
  window.history.replaceState({ page: 1 }, '', '#cover');
  $book.turn({
    ...dimensions(),
    page: 1,
    display: 'double',
    autoCenter: true,
    acceleration: true,
    gradients: !motionQuery.matches,
    // The legacy engine divides by duration; 1 ms avoids zero-duration NaNs.
    duration: motionQuery.matches ? 1 : 850,
    when: {
      turning(event, page, view) {
        const focusedFace = document.activeElement?.closest('.face');
        if (focusedFace && !view.includes(faces.indexOf(focusedFace) + 1)) book.focus({ preventScroll: true });
        previous.disabled = next.disabled = true;
        book.setAttribute('aria-busy', 'true');
      },
      turned(event, page, view) {
        syncReader(page, view);
        const hash = '#' + faces[page - 1].id;
        if (!restoringHistory && window.location.hash !== hash) window.history.pushState({ page }, '', hash);
        restoringHistory = false;
      }
    }
  });
  syncReader(undefined, undefined, false);

  // Selection, page order, animations, and drag gestures are owned by Turn.js.
  function navigate(method, page) {
    if (portraitQuery.matches || dialog.open || $book.turn('animating')) return;
    if (method === 'page' && (!Number.isInteger(page) || page < 1 || page > faces.length)) return;
    $book.turn(method, page);
    if (mobileQuery.matches && book.getBoundingClientRect().top < 0) book.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  previous.addEventListener('click', () => navigate('previous'));
  next.addEventListener('click', () => navigate('next'));

  // Buttons near a corner must not also initiate the library's drag gesture.
  book.addEventListener('mousedown', protectControl, true);
  book.addEventListener('touchstart', protectControl, true);
  function protectControl(event) {
    if (event.target.closest('a, button')) event.stopPropagation();
  }

  document.addEventListener('click', event => {
    const jump = event.target.closest('[data-page]');
    if (jump) { event.preventDefault(); navigate('page', Number(jump.dataset.page)); return; }
    const step = event.target.closest('[data-step]');
    if (step) { navigate(Number(step.dataset.step) > 0 ? 'next' : 'previous'); return; }
    const imageButton = event.target.closest('[data-image]');
    if (imageButton && !$book.turn('animating')) {
      imageTrigger = imageButton;
      const image = document.querySelector('#enlarged-image');
      const preview = imageButton.querySelector('img');
      const width = Number(preview.getAttribute('width')) || preview.naturalWidth;
      const height = Number(preview.getAttribute('height')) || preview.naturalHeight;
      const portrait = width > 0 && height > width;
      dialog.classList.toggle('portrait-viewer', portrait);
      dialog.style.setProperty('--image-ratio', portrait ? width / height : 1);
      image.src = imageButton.dataset.image;
      image.alt = imageButton.dataset.caption;
      dialog.setAttribute('aria-label', imageButton.dataset.viewerTitle || imageButton.dataset.caption);
      Object.assign(viewer, { width, height, zoom: 1, renderedWidth: 0, renderedHeight: 0 });
      imageCanvas.style.width = imageCanvas.style.height = '0px';
      dialog.showModal();
      document.documentElement.classList.add('dialog-open');
      renderViewer();
      document.querySelector('#close-dialog').focus();
      return;
    }
    if (event.target.closest('#cover') && $book.turn('page') === 1) navigate('next');
    else if (event.target.closest('#back-cover') && $book.turn('page') === faces.length) navigate('previous');
  });

  document.addEventListener('keydown', event => {
    if (portraitQuery.matches || dialog.open || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const actions = {
      ArrowLeft: () => navigate('previous'), ArrowRight: () => navigate('next'),
      Home: () => navigate('page', 1), End: () => navigate('page', faces.length)
    };
    if (actions[event.key]) { event.preventDefault(); actions[event.key](); }
  });

  function resizeBook() {
    const page = $book.turn('page');
    $book.turn('stop');
    $book.turn('display', 'double');
    const { width, height } = dimensions();
    $book.turn('size', width, height);
    $book.turn('page', page);
    syncReader();
  }
  function scheduleResize() {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => { resizeBook(); renderViewer(); });
  }
  window.addEventListener('resize', scheduleResize);
  window.visualViewport?.addEventListener('resize', scheduleResize);
  landscapeReaderQuery.addEventListener('change', scheduleResize);
  document.fonts?.ready.then(resizeBook);
  motionQuery.addEventListener('change', () => {
    $book.turn('stop');
    $book.turn('options', { duration: motionQuery.matches ? 1 : 850, gradients: !motionQuery.matches });
    syncReader();
  });
  window.addEventListener('popstate', () => {
    const index = faces.findIndex(face => '#' + face.id === window.location.hash);
    const target = index < 0 ? 1 : index + 1;
    $book.turn('stop');
    restoringHistory = target !== $book.turn('page');
    $book.turn('page', target);
    if (!restoringHistory) syncReader();
  });

  document.querySelector('#close-dialog').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    endImagePan();
    document.documentElement.classList.remove('dialog-open');
    imageTrigger?.focus({ preventScroll: true });
  });
  window.addEventListener('beforeprint', () => {
    printBook?.remove();
    printBook = document.createElement('div');
    printBook.className = 'print-book';
    printBook.append(...faces.map(copyFace));
    document.querySelector('#main').append(printBook);
  });
  window.addEventListener('afterprint', () => { printBook?.remove(); printBook = null; });
})();
