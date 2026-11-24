$(document).ready(function () {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const DB_NAME = "MangaFlipLibraryDB";
  const DB_VERSION = 1;
  const STORE_NAME = "mangaBooks";

  const TURN_DURATIONS = {
    crisp: 450,
    smooth: 650,
    slow: 950,
  };

  const state = {
    bookId: null,
    bookTitle: "Sample Volume",
    pages: [], // Active object URLs or Data URLs
    currentPage: 1,
    mode: "flip", // 'flip' | 'webtoon' | 'horizontal'
    direction: "rtl", // 'rtl' (Manga) | 'ltr'
    display: window.innerWidth < 768 ? "single" : "double",
    turnStyle: "smooth",
    zoom: 1,
    panX: 0,
    panY: 0,
    isDragging: false,
    startX: 0,
    startY: 0,
    isRapidFlipping: false,
    library: [],
  };

  let db = null;

  // --- INDEXEDDB LAYER (Persistent Manga Shelf) ---
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const database = e.target.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      req.onsuccess = (e) => {
        db = e.target.result;
        resolve(db);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function dbGetAllBooks() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  function dbPutBook(bookRecord) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(bookRecord);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  function dbDeleteBook(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  function revokeActiveUrls() {
    state.pages.forEach((src) => {
      if (typeof src === "string" && src.startsWith("blob:")) {
        URL.revokeObjectURL(src);
      }
    });
  }

  function blobsToUrls(blobs) {
    revokeActiveUrls();
    return blobs.map((b) => (typeof b === "string" ? b : URL.createObjectURL(b)));
  }

  // --- DASHBOARD RENDERING ---
  async function refreshLibrary(filterText = "") {
    state.library = await dbGetAllBooks();
    state.library.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const q = filterText.trim().toLowerCase();
    const list = q
      ? state.library.filter((b) => (b.title || "").toLowerCase().includes(q))
      : state.library;

    const $grid = $("#library-grid").empty();
    if (!list.length) {
      $grid.append(
        `<div style="opacity:0.7;font-size:14px;">No saved manga yet. Click <b>＋ Add Manga</b> to upload images, CBZ, ZIP, or PDF.</div>`
      );
      return;
    }

    list.forEach((book) => {
      const coverUrl = book.coverBlob ? URL.createObjectURL(book.coverBlob) : "";
      const lastPage = book.lastPage || 1;
      const total = book.pageBlobs ? book.pageBlobs.length : 0;

      const $card = $(`
        <div class="manga-card" data-id="${book.id}">
          <div class="manga-cover-wrap" title="Open ${escapeHtml(book.title)}">
            <img src="${coverUrl}" alt="${escapeHtml(book.title)}" loading="lazy" />
            <span class="manga-progress-badge">P.${lastPage}/${total}</span>
          </div>
          <div class="manga-card-body">
            <div>
              <div class="manga-title">${escapeHtml(book.title)}</div>
              <div class="manga-meta">${total} pages • ${(book.direction || "rtl").toUpperCase()}</div>
            </div>
            <div class="manga-card-btns">
              <button class="btn primary-btn open-book-btn">Read</button>
              <button class="btn rename-book-btn" title="Rename">✎</button>
              <button class="btn del-book-btn" title="Delete">🗑</button>
            </div>
          </div>
        </div>
      `);

      $card.find(".manga-cover-wrap, .open-book-btn").on("click", () => {
        loadBookFromLibrary(book.id);
        toggleLibraryDrawer(false);
      });

      $card.find(".rename-book-btn").on("click", async (e) => {
        e.stopPropagation();
        const nextName = prompt("Rename manga title:", book.title);
        if (nextName && nextName.trim()) {
          book.title = nextName.trim();
          await dbPutBook(book);
          if (state.bookId === book.id) {
            state.bookTitle = book.title;
            $("#file-status").text(`${state.bookTitle} (${state.pages.length}p)`);
          }
          refreshLibrary($("#library-search").val());
        }
      });

      $card.find(".del-book-btn").on("click", async (e) => {
        e.stopPropagation();
        if (confirm(`Delete "${book.title}" from your saved shelf?`)) {
          await dbDeleteBook(book.id);
          refreshLibrary($("#library-search").val());
        }
      });

      $grid.append($card);
    });
  }

  async function loadBookFromLibrary(bookId) {
    const all = await dbGetAllBooks();
    const book = all.find((b) => b.id === bookId);
    if (!book || !book.pageBlobs || !book.pageBlobs.length) return;

    state.bookId = book.id;
    state.bookTitle = book.title;
    state.pages = blobsToUrls(book.pageBlobs);
    state.currentPage = Math.min(state.pages.length, Math.max(1, book.lastPage || 1));
    state.direction = book.direction || state.direction;
    resetTransform();
    $("#file-status").text(`${state.bookTitle} (${state.pages.length}p)`);
    renderAll();
  }

  async function saveCurrentProgress() {
    if (!state.bookId || !db) return;
    const all = await dbGetAllBooks();
    const book = all.find((b) => b.id === state.bookId);
    if (!book) return;
    book.lastPage = state.currentPage;
    book.direction = state.direction;
    book.updatedAt = Date.now();
    await dbPutBook(book);
  }

  function toggleLibraryDrawer(forceState) {
    const isHidden = $("#library-drawer").hasClass("hidden");
    const show = typeof forceState === "boolean" ? forceState : isHidden;
    if (show) {
      refreshLibrary($("#library-search").val());
      $("#library-drawer").removeClass("hidden");
    } else {
      $("#library-drawer").addClass("hidden");
    }
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // --- SAMPLE DECK (First-time demo before uploading) ---
  function loadSampleDeck() {
    const colors = ["#264653", "#2a9d8f", "#e9c46a", "#f4a261", "#e76f51", "#1d3557"];
    revokeActiveUrls();
    state.bookId = null;
    state.bookTitle = "Sample Deck";
    state.pages = colors.map((hex, i) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="850">
        <rect width="100%" height="100%" fill="${hex}"/>
        <text x="50%" y="44%" font-family="sans-serif" font-size="40" fill="#fff" text-anchor="middle">Page ${i + 1}</text>
        <text x="50%" y="52%" font-family="sans-serif" font-size="18" fill="#eee" text-anchor="middle">Add Manga to Save to Shelf</text>
      </svg>`;
      return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
    state.currentPage = 1;
    $("#file-status").text("Sample Deck");
    renderAll();
  }

  const naturalSort = (a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

  // --- MULTI-FORMAT UPLOAD & SAVE TO INDEXEDDB ---
  $("#file-upload").on("change", async function (e) {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    $("#file-status").text("Extracting & saving...");
    files.sort((a, b) => naturalSort(a.name, b.name));

    const pageBlobs = [];
    let inferredTitle = files[0].name.replace(/\.(cbz|zip|pdf|jpe?g|png|webp|gif|bmp|avif)$/i, "");

    for (const file of files) {
      const ext = file.name.split(".").pop().toLowerCase();

      if (["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"].includes(ext)) {
        pageBlobs.push(file);
      } else if (ext === "cbz" || ext === "zip") {
        const zip = await JSZip.loadAsync(file);
        const imgEntries = Object.keys(zip.files)
          .filter((name) => !zip.files[name].dir && /\.(jpe?g|png|webp|gif|avif)$/i.test(name))
          .sort(naturalSort);

        for (const name of imgEntries) {
          const blob = await zip.files[name].async("blob");
          pageBlobs.push(blob);
        }
      } else if (ext === "pdf") {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        for (let p = 1; p <= pdf.numPages; p++) {
          const page = await pdf.getPage(p);
          const viewport = page.getViewport({ scale: 1.6 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
          const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.88));
          if (blob) pageBlobs.push(blob);
        }
      }
    }

    if (!pageBlobs.length) {
      $("#file-status").text("No valid images found");
      return;
    }

    const id = "manga_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    const record = {
      id,
      title: inferredTitle || "Untitled Manga",
      coverBlob: pageBlobs[0],
      pageBlobs,
      lastPage: 1,
      direction: state.direction,
      updatedAt: Date.now(),
    };

    await dbPutBook(record);
    await loadBookFromLibrary(id);
    toggleLibraryDrawer(false);
    e.target.value = "";
  });

  // --- STACKED PAGE THICKNESS & BOOK RENDERING ---
  function updateStackThickness() {
    const total = Math.max(1, state.pages.length);
    const cur = Math.min(total, Math.max(1, state.currentPage));
    const maxPx = 14;
    const minPx = 2;

    const beforeRatio = (cur - 1) / total;
    const afterRatio = (total - cur) / total;

    const leftPx = Math.round(minPx + beforeRatio * (maxPx - minPx));
    const rightPx = Math.round(minPx + afterRatio * (maxPx - minPx));

    document.documentElement.style.setProperty("--left-stack", `${leftPx}px`);
    document.documentElement.style.setProperty("--right-stack", `${rightPx}px`);
    $("#book-stage").toggleClass("single-book", state.display === "single");
  }

  function renderAll() {
    $("#page-total").text(`/ ${state.pages.length}`);
    $("#page-input").attr("max", state.pages.length).val(state.currentPage);
    $("#spread-btn").text(state.display === "double" ? "🗐 Double" : "🗎 Single");
    $("#dir-btn").text(state.direction === "rtl" ? "⬅ RTL (Manga)" : "LTR ➔");

    updateStackThickness();
    renderThumbnails();

    if (state.mode === "flip") {
      $("#book-stage").removeClass("hidden");
      $("#scroll-reader").addClass("hidden");
      $("#zone-left, #zone-right").removeClass("hidden");
      initFlipbook();
    } else {
      $("#book-stage").addClass("hidden");
      $("#zone-left, #zone-right").addClass("hidden");
      $("#scroll-reader")
        .removeClass("hidden")
        .toggleClass("horizontal", state.mode === "horizontal");
      renderScrollReader();
    }
  }

  function initFlipbook() {
    const $wrapper = $("#flipbook-wrapper");
    if ($("#flipbook").data("turn")) {
      $("#flipbook").turn("destroy");
    }
    $wrapper.html('<div id="flipbook" class="flipbook"></div>');
    const $fb = $("#flipbook");

    const orderedPages =
      state.direction === "rtl" ? [...state.pages].reverse() : state.pages;

    orderedPages.forEach((src, idx) => {
      const realPageNum =
        state.direction === "rtl" ? state.pages.length - idx : idx + 1;

      // Mark first and last sheets as stiff cover/card stock
      const isFirst = idx === 0;
      const isLast = idx === orderedPages.length - 1;
      const hardClass = isFirst || isLast ? "hard" : "";
      const endCardClass = isLast ? "hard-endcard" : "";

      $fb.append(
        `<div class="page ${hardClass} ${endCardClass}" data-real-page="${realPageNum}">
          <img src="${src}" alt="Page ${realPageNum}" />
        </div>`
      );
    });

    const dims = calculateBookDimensions();
    const startTurnPage =
      state.direction === "rtl"
        ? state.pages.length - state.currentPage + 1
        : state.currentPage;

    $fb.turn({
      width: dims.width,
      height: dims.height,
      display: state.display,
      autoCenter: true,
      gradients: true,
      acceleration: true,
      duration: TURN_DURATIONS[state.turnStyle] || 650,
      page: startTurnPage,
      when: {
        turned: function (e, page) {
          const realPage =
            state.direction === "rtl" ? state.pages.length - page + 1 : page;
          state.currentPage = realPage;
          $("#page-input").val(realPage);
          updateStackThickness();
          highlightThumbnail(realPage);
          saveCurrentProgress();
        },
      },
    });
  }

  function calculateBookDimensions() {
    const availW = window.innerWidth * 0.9;
    const availH = window.innerHeight - 154;
    const aspect = 0.7;
    let pageH = availH;
    let pageW = pageH * aspect;

    const totalW = state.display === "double" ? pageW * 2 : pageW;
    if (totalW > availW) {
      const scale = availW / totalW;
      pageW *= scale;
      pageH *= scale;
    }
    return {
      width: Math.round(state.display === "double" ? pageW * 2 : pageW),
      height: Math.round(pageH),
    };
  }

  function renderScrollReader() {
    const $sr = $("#scroll-reader").empty();
    state.pages.forEach((src, idx) => {
      const $img = $(`<img src="${src}" data-page="${idx + 1}" loading="lazy" />`);
      $img.on("click", () => {
        state.currentPage = idx + 1;
        $("#page-input").val(state.currentPage);
        updateStackThickness();
        highlightThumbnail(state.currentPage);
        saveCurrentProgress();
      });
      $sr.append($img);
    });
  }

  function renderThumbnails() {
    const $strip = $("#thumbnail-strip").empty();
    state.pages.forEach((src, idx) => {
      const pNum = idx + 1;
      const $slide = $(`
        <div class="thumb-slide ${pNum === state.currentPage ? "active" : ""}" data-page="${pNum}">
          <img src="${src}" loading="lazy" />
          <span class="thumb-num">${pNum}</span>
        </div>
      `);
      $slide.on("click", () => goToPage(pNum, true));
      $strip.append($slide);
    });
  }

  function highlightThumbnail(pageNum) {
    $(".thumb-slide").removeClass("active");
    const $active = $(`.thumb-slide[data-page="${pageNum}"]`).addClass("active");
    if ($active.length) {
      $active[0].scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
  }

  function goToPage(targetPage, rapidFlip = true) {
    targetPage = Math.max(1, Math.min(state.pages.length, parseInt(targetPage, 10)));
    if (isNaN(targetPage)) return;

    if (state.mode !== "flip") {
      state.currentPage = targetPage;
      $("#page-input").val(targetPage);
      updateStackThickness();
      highlightThumbnail(targetPage);
      saveCurrentProgress();
      const $img = $(`#scroll-reader img[data-page="${targetPage}"]`);
      if ($img.length) $img[0].scrollIntoView({ behavior: "smooth" });
      return;
    }

    const $fb = $("#flipbook");
    const turnTarget =
      state.direction === "rtl" ? state.pages.length - targetPage + 1 : targetPage;

    if (!rapidFlip || state.isRapidFlipping) {
      $fb.turn("page", turnTarget);
      return;
    }

    let currentTurn = $fb.turn("page");
    if (currentTurn === turnTarget) return;

    state.isRapidFlipping = true;
    const step =
      turnTarget > currentTurn
        ? state.display === "double" ? 2 : 1
        : state.display === "double" ? -2 : -1;
    const originalDuration = $fb.turn("options").duration;
    $fb.turn("options", { duration: 140 });

    const flipInterval = setInterval(() => {
      currentTurn += step;
      const reached =
        (step > 0 && currentTurn >= turnTarget) ||
        (step < 0 && currentTurn <= turnTarget);

      if (reached) {
        clearInterval(flipInterval);
        $fb.turn("page", turnTarget);
        setTimeout(() => {
          $fb.turn("options", { duration: originalDuration });
          state.isRapidFlipping = false;
        }, 160);
      } else {
        $fb.turn("page", currentTurn);
      }
    }, 110);
  }

  // --- NAVIGATION & KEYBOARD ---
  $("#zone-right").on("click", () => {
    if (state.zoom > 1) return;
    $("#flipbook").turn("next");
  });

  $("#zone-left").on("click", () => {
    if (state.zoom > 1) return;
    $("#flipbook").turn("previous");
  });

  $(document).on("keydown", (e) => {
    if ($(e.target).is("input, select")) return;
    if (e.key === "ArrowRight") $("#flipbook").turn("next");
    if (e.key === "ArrowLeft") $("#flipbook").turn("previous");
  });

  // --- ZOOM & PAN ---
  function applyTransform() {
    $("#pan-zoom-layer").css(
      "transform",
      `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`
    );
    $("#zoom-level").text(`${Math.round(state.zoom * 100)}%`);
  }

  function resetTransform() {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    applyTransform();
  }

  $("#zoom-in").on("click", () => {
    state.zoom = Math.min(4, +(state.zoom + 0.25).toFixed(2));
    applyTransform();
  });

  $("#zoom-out").on("click", () => {
    state.zoom = Math.max(0.5, +(state.zoom - 0.25).toFixed(2));
    if (state.zoom <= 1) {
      state.panX = 0;
      state.panY = 0;
    }
    applyTransform();
  });

  $("#zoom-reset").on("click", resetTransform);

  $("#viewport").on("wheel", function (e) {
    if (state.mode !== "flip") return;
    e.preventDefault();
    const delta = e.originalEvent.deltaY < 0 ? 0.15 : -0.15;
    state.zoom = Math.min(4, Math.max(0.5, +(state.zoom + delta).toFixed(2)));
    if (state.zoom <= 1) {
      state.panX = 0;
      state.panY = 0;
    }
    applyTransform();
  });

  const viewportEl = document.getElementById("viewport");
  viewportEl.addEventListener("pointerdown", (e) => {
    if (state.zoom <= 1) return;
    state.isDragging = true;
    state.startX = e.clientX - state.panX;
    state.startY = e.clientY - state.panY;
  });

  window.addEventListener("pointermove", (e) => {
    if (!state.isDragging) return;
    state.panX = e.clientX - state.startX;
    state.panY = e.clientY - state.startY;
    applyTransform();
  });

  window.addEventListener("pointerup", () => {
    state.isDragging = false;
  });

  // --- CONTROLS ---
  $("#library-btn").on("click", () => toggleLibraryDrawer());
  $("#close-library-btn").on("click", () => toggleLibraryDrawer(false));
  $("#library-search").on("input", function () {
    refreshLibrary($(this).val());
  });

  $("#mode-select").on("change", function () {
    state.mode = $(this).val();
    resetTransform();
    renderAll();
  });

  $("#dir-btn").on("click", function () {
    state.direction = state.direction === "rtl" ? "ltr" : "rtl";
    renderAll();
    saveCurrentProgress();
  });

  $("#spread-btn").on("click", function () {
    state.display = state.display === "double" ? "single" : "double";
    renderAll();
  });

  $("#jump-btn").on("click", () => goToPage($("#page-input").val(), true));
  $("#page-input").on("keypress", (e) => {
    if (e.key === "Enter") goToPage($("#page-input").val(), true);
  });

  $("#book-style-select").on("change", function () {
    $("html").attr("data-book-style", $(this).val());
  });

  $("#paper-select").on("change", function () {
    $("html").attr("data-paper", $(this).val());
  });

  $("#turn-style-select").on("change", function () {
    state.turnStyle = $(this).val();
    if (state.mode === "flip" && $("#flipbook").data("turn")) {
      $("#flipbook").turn("options", { duration: TURN_DURATIONS[state.turnStyle] });
    }
  });

  $("#theme-btn").on("click", function () {
    const isDark = $("html").attr("data-theme") === "dark";
    $("html").attr("data-theme", isDark ? "light" : "dark");
    $(this).text(isDark ? "☀️" : "🌙");
  });

  $(window).on("resize", () => {
    if (state.mode === "flip" && $("#flipbook").data("turn")) {
      const dims = calculateBookDimensions();
      $("#flipbook").turn("size", dims.width, dims.height);
    }
  });

  // --- BOOTSTRAP ---
  openDB()
    .then(async () => {
      const books = await dbGetAllBooks();
      if (books && books.length) {
        books.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        await loadBookFromLibrary(books[0].id);
        $("#library-drawer").addClass("hidden");
      } else {
        loadSampleDeck();
        $("#library-drawer").addClass("hidden");
      }
    })
    .catch(() => {
      loadSampleDeck();
      $("#library-drawer").addClass("hidden");
    });
});