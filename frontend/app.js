function normalizeBaseUrl(value) {
    const raw = String(value || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (/^\/\//.test(raw)) return `${window.location.protocol}${raw}`;

    // Treat bare hosts/IPs as absolute origins instead of relative paths.
    if (/^[a-z0-9.-]+(?::\d+)?$/i.test(raw)) {
        const scheme = window.location.protocol === 'https:' ? 'https://' : 'http://';
        return `${scheme}${raw}`;
    }

    return raw;
}

function joinBaseUrl(base, path) {
    if (!base) return path;
    if (!path) return base;
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function frontendUrl(path) {
    return new URL(path, document.baseURI).toString();
}

function apiUrl(path) {
    return joinBaseUrl(API, path);
}

function backendAssetUrl(path) {
    if (!path) return path;
    if (/^(?:[a-z]+:)?\/\//i.test(path) || path.startsWith('data:')) return path;
    return apiUrl(path);
}

const API = normalizeBaseUrl(window.SONOX_CONFIG?.apiBaseUrl || '');
let currentDataset = 'lymph-node';
let uploadedFile = null;
let currentLang = 'en';

// ══════════════════════════════════════════════════════════════════════
// Internationalization (i18n)
// ══════════════════════════════════════════════════════════════════════
const translations = {};

async function loadTranslations(lang) {
    try {
        const resp = await fetch(frontendUrl(`translations/${lang}.json`));
        if (!resp.ok) return;
        const data = await resp.json();
        translations[lang] = data;
        currentLang = lang;
        applyTranslations(data);
        updateAllStatusText();
        document.querySelectorAll('.lang-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.lang === lang);
        });
        localStorage.setItem('sonox-lang', lang);
    } catch (e) {
        console.log('Translation file not found, using defaults');
    }
}

function applyTranslations(data) {
    const htmlKeys = new Set(['disclaimer.content', 'disclaimer.text']);
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const keys = key.split('.');
        let val = data;
        for (const k of keys) {
            if (val && typeof val === 'object') val = val[k];
            else { val = null; break; }
        }
        if (typeof val === 'string') {
            if (el.tagName === 'INPUT') el.placeholder = val;
            else if (htmlKeys.has(key)) el.innerHTML = val;
            else el.textContent = val;
        }
    });
}

document.getElementById('langSwitcher').addEventListener('click', e => {
    const btn = e.target.closest('.lang-btn');
    if (btn) loadTranslations(btn.dataset.lang);
});

// ══════════════════════════════════════════════════════════════════════
// Tab Navigation
// ══════════════════════════════════════════════════════════════════════
document.getElementById('tabs').addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentDataset = tab.dataset.dataset;
    loadExamples(currentDataset);
});

// ══════════════════════════════════════════════════════════════════════
// Image Upload
// ══════════════════════════════════════════════════════════════════════
const uploadZone = document.getElementById('uploadZone');
const uploadInput = document.getElementById('uploadInput');
const uploadPreview = document.getElementById('uploadPreview');
const uploadPlaceholder = document.getElementById('uploadPlaceholder');

uploadZone.addEventListener('click', e => {
    if (e.target === uploadPreview) return;
    uploadInput.click();
});

uploadZone.addEventListener('dragover', e => {
    e.preventDefault();
    uploadZone.classList.add('drag-over');
});

uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('drag-over');
});

uploadZone.addEventListener('drop', e => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});

uploadInput.addEventListener('change', e => {
    if (e.target.files.length) handleFile(e.target.files[0]);
});

function handleFile(file, sampleId = null) {
    uploadedFile = file;
    currentSampleId = sampleId;
    const reader = new FileReader();
    reader.onload = e => {
        uploadPreview.src = e.target.result;
        uploadPreview.style.display = 'block';
        uploadPlaceholder.style.display = 'none';
        uploadZone.classList.add('has-image');
    };
    reader.readAsDataURL(file);
}

document.getElementById('clearBtn').addEventListener('click', () => {
    uploadedFile = null;
    currentSampleId = null;
    uploadPreview.style.display = 'none';
    uploadPlaceholder.style.display = '';
    uploadZone.classList.remove('has-image');
    uploadInput.value = '';
    currentMaskPath = null;
    currentClassificationMask = null;
    lastClsResult = null;
    lastInputB64 = null;
    lastAnalysisData = null;
    currentResultsCoverage = {};
    currentGtCoverage = null;

    // Reset static panel slider
    const ourModelSlider = document.getElementById('our-model-slider');
    if (ourModelSlider) {
        ourModelSlider.innerHTML = `<div class="placeholder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 3v18M3 9h18" />
            </svg>
            <span data-i18n="results.placeholder">Upload an image and click Start Analysis</span>
        </div>`;
    }
    const ourModelStatus = document.getElementById('our-model-status');
    if (ourModelStatus) ourModelStatus.textContent = '';

    updateGroundTruth(null);
    resetClsPanel();
    renderAnalysisGrid();

    if (translations[currentLang]) {
        applyTranslations(translations[currentLang]);
    }
});

// ══════════════════════════════════════════════════════════════════════
// Gallery / Reference Samples
// ══════════════════════════════════════════════════════════════════════
let currentMaskPath = null;
let currentSampleId = null;
let currentGtCoverage = null;
let currentResultsCoverage = {};
let currentClassificationMask = null;
let lastClsResult = null;
let currentClsState = 'none';
let lastInputB64 = null;

async function loadExamples(dataset) {
    const gallery = document.getElementById('gallery');
    gallery.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--muted);font-size:13px;padding:60px 20px">Loading samples...</div>';

    try {
        const resp = await fetch(apiUrl('/api/datasets'));
        const data = await resp.json();
        const examples = data[dataset]?.examples || [];

        if (examples.length === 0) {
            gallery.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--muted);font-size:13px;padding:60px 20px">No samples available for this region</div>';
            return;
        }

        gallery.innerHTML = '';
        examples.forEach(ex => {
            const div = document.createElement('div');
            div.className = 'gallery-item';
            const img = document.createElement('img');
            img.src = backendAssetUrl(ex.image);
            img.loading = 'lazy';
            img.draggable = false;
            img.alt = 'Reference ultrasound sample';
            div.appendChild(img);
            div.addEventListener('click', () => {
                document.querySelectorAll('.gallery-item').forEach(item => item.classList.remove('selected'));
                div.classList.add('selected');
                currentMaskPath = ex.mask;
                fetch(backendAssetUrl(ex.image)).then(r => r.blob()).then(blob => {
                    const fileName = ex.image.split('/').pop();
                    const file = new File([blob], fileName, { type: 'image/png' });
                    handleFile(file, ex.sample_id || fileName);
                    updateGroundTruth(ex.mask, file);
                });
            });
            gallery.appendChild(div);
        });
    } catch (e) {
        gallery.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--muted);font-size:13px;padding:60px 20px">Unable to load samples. Check that the backend URL is correct and reachable over HTTPS.</div>';
    }
}

async function updateGroundTruth(maskPath, imageFile) {
    // GT card only makes sense in full-comparison mode
    if (!isFullComparison) return;

    let gtSlider = document.getElementById('gt-slider');
    let gtStatus = document.getElementById('gt-status');

    // If GT card doesn't exist yet (e.g., user switched from upload to sample
    // while in full comparison mode), create it on-the-fly
    if ((!gtSlider || !gtStatus) && maskPath) {
        const resultsBody = document.getElementById('resultsBody');
        const gtCard = createGtCard();
        resultsBody.insertBefore(gtCard, resultsBody.firstChild);
        gtSlider = document.getElementById('gt-slider');
        gtStatus = document.getElementById('gt-status');
        if (translations[currentLang]) {
            applyTranslations(translations[currentLang]);
        }
    }

    if (!gtSlider || !gtStatus) return;

    if (!maskPath) {
        gtSlider.innerHTML = `<div class="placeholder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
            </svg>
            <span data-i18n="gt.placeholder">Select a reference sample to view ground truth</span>
        </div>`;
        gtStatus.textContent = '';
        currentGtCoverage = null;
        allSliders = allSliders.filter(s => s.container !== gtSlider);
        return;
    }

    if (!imageFile) return;

    gtSlider.innerHTML = `<div class="placeholder"><span>Loading ground truth...</span></div>`;
    gtStatus.textContent = '';

    try {
        const formData = new FormData();
        formData.append('image', imageFile);
        formData.append('mask_path', maskPath);

        const resp = await fetch(apiUrl('/api/gt-overlay'), { method: 'POST', body: formData });
        const data = await resp.json();

        if (data.error) {
            gtSlider.innerHTML = `<div class="placeholder"><span>${data.error}</span></div>`;
            return;
        }

        const reader = new FileReader();
        reader.onload = e => {
            const originalB64 = e.target.result.split(',')[1];
            allSliders = allSliders.filter(s => s.container !== gtSlider);
            initSlider(gtSlider, originalB64, data.overlay, 'slider.ground_truth');

            currentGtCoverage = data.coverage;
            updateGtStatusText();
        };
        reader.readAsDataURL(imageFile);
    } catch (e) {
        gtSlider.innerHTML = `<div class="placeholder"><span>Error loading ground truth</span></div>`;
    }
}

function updateGtStatusText() {
    const gtStatus = document.getElementById('gt-status');
    if (!gtStatus) return;
    if (currentGtCoverage !== null) {
        const lesionText = translations[currentLang]?.results?.lesion_area || 'Lesion Area';
        gtStatus.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> ${lesionText}: ${currentGtCoverage}%`;
    }
}

function updateAllStatusText() {
    updateGtStatusText();

    const lesionText = translations[currentLang]?.results?.lesion_area || 'Lesion Area';
    document.querySelectorAll('[data-model]').forEach(statusEl => {
        const modelName = statusEl.dataset.model;
        const coverage = currentResultsCoverage[modelName];
        if (coverage !== undefined) {
            statusEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> ${lesionText}: ${coverage}%`;
        }
    });

    if (lastClsResult && currentClsState === 'result') {
        renderClsPipeline(lastClsResult);
    } else if (currentClsState === 'no_lesion') {
        renderClsNoLesion();
    }
}

// ══════════════════════════════════════════════════════════════════════
// Image Comparison Slider (Synchronized)
// ══════════════════════════════════════════════════════════════════════
const SLIDER_DEFAULT_PCT = 10;
let allSliders = [];

function syncAllSliders(sourceContainer, pct) {
    allSliders.forEach(s => {
        if (s.container !== sourceContainer) {
            const beforeImg = s.container.querySelector('.img-before');
            const handle = s.container.querySelector('.handle');
            if (beforeImg && handle) {
                beforeImg.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
                handle.style.left = pct + '%';
            }
        }
    });
}

function initSlider(container, originalB64, overlayB64, labelRightKey = 'slider.segmentation') {
    container.innerHTML = '';

    const afterImg = document.createElement('img');
    afterImg.className = 'img-after';
    afterImg.src = `data:image/png;base64,${overlayB64}`;
    afterImg.draggable = false;
    afterImg.alt = 'Segmentation result';
    afterImg.addEventListener('dragstart', e => e.preventDefault());

    const beforeImg = document.createElement('img');
    beforeImg.className = 'img-before';
    beforeImg.src = `data:image/png;base64,${originalB64}`;
    beforeImg.draggable = false;
    beforeImg.alt = 'Original image';
    beforeImg.addEventListener('dragstart', e => e.preventDefault());
    beforeImg.style.clipPath = `inset(0 ${100 - SLIDER_DEFAULT_PCT}% 0 0)`;

    const handle = document.createElement('div');
    handle.className = 'handle';
    handle.style.left = SLIDER_DEFAULT_PCT + '%';

    const knob = document.createElement('div');
    knob.className = 'handle-knob';
    knob.innerHTML = '&#9664;&#9654;';
    handle.appendChild(knob);

    const labelL = document.createElement('div');
    labelL.className = 'label label-left';
    labelL.setAttribute('data-i18n', 'slider.original');
    const origParts = 'slider.original'.split('.');
    labelL.textContent = translations[currentLang]?.[origParts[0]]?.[origParts[1]] || 'Original';

    const labelR = document.createElement('div');
    labelR.className = 'label label-right';
    labelR.setAttribute('data-i18n', labelRightKey);
    const rParts = labelRightKey.split('.');
    labelR.textContent = translations[currentLang]?.[rParts[0]]?.[rParts[1]] || 'Segmentation';

    container.appendChild(afterImg);
    container.appendChild(beforeImg);
    container.appendChild(handle);
    container.appendChild(labelL);
    container.appendChild(labelR);

    let dragging = false;

    function update(x) {
        const rect = container.getBoundingClientRect();
        const pct = Math.max(0, Math.min((x - rect.left) / rect.width * 100, 100));
        beforeImg.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
        handle.style.left = pct + '%';
        syncAllSliders(container, pct);
    }

    container.addEventListener('mousedown', e => { dragging = true; update(e.clientX); });
    document.addEventListener('mousemove', e => { if (dragging) { e.preventDefault(); update(e.clientX); } });
    document.addEventListener('mouseup', () => { dragging = false; });
    container.addEventListener('touchstart', e => { dragging = true; update(e.touches[0].clientX); }, { passive: true });
    container.addEventListener('touchmove', e => { if (dragging) { e.preventDefault(); update(e.touches[0].clientX); } }, { passive: false });
    container.addEventListener('touchend', () => { dragging = false; });

    allSliders.push({ container, beforeImg, handle });
}

// ══════════════════════════════════════════════════════════════════════
// Lesion Classification - Pipeline Visualization
// ══════════════════════════════════════════════════════════════════════
function renderClsLoading() {
    const clsBody = document.getElementById('clsBody');
    currentClsState = 'loading';
    clsBody.innerHTML = `
        <div class="cls-loading">
            <div class="cls-loading-spinner"></div>
            <p class="cls-loading-text">Running classification...</p>
        </div>`;
}

function renderClsError(message) {
    const clsBody = document.getElementById('clsBody');
    currentClsState = 'error';
    const safeMessage = message || 'Classification failed';
    clsBody.innerHTML = `
        <div class="cls-placeholder cls-error">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <p class="cls-placeholder-title">Classification unavailable</p>
            <p class="cls-placeholder-text">${safeMessage}</p>
        </div>`;
}

function renderClsNoLesion() {
    const clsBody = document.getElementById('clsBody');
    currentClsState = 'no_lesion';
    clsBody.innerHTML = `
        <div class="cls-placeholder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p class="cls-placeholder-title" data-i18n="cls.no_lesion_title">No Lesion Detected</p>
            <p class="cls-placeholder-text" data-i18n="cls.no_lesion_text">Classification requires a lesion. The AI model did not detect any lesion in this image.</p>
        </div>`;
    if (translations[currentLang]) {
        applyTranslations(translations[currentLang]);
    }
}

function resetClsPanel() {
    const clsBody = document.getElementById('clsBody');
    currentClsState = 'none';
    clsBody.innerHTML = `
        <div class="cls-placeholder" id="clsPlaceholder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
            </svg>
            <p class="cls-placeholder-title" data-i18n="cls.placeholder_title">Run analysis first</p>
            <p class="cls-placeholder-text" data-i18n="cls.placeholder_text">Classification results will appear after segmentation</p>
        </div>`;
    if (translations[currentLang]) {
        applyTranslations(translations[currentLang]);
    }
}

function renderClsPipeline(data) {
    const clsBody = document.getElementById('clsBody');
    currentClsState = 'result';
    const t = translations[currentLang]?.cls || {};
    const classes = data.classes;
    const probs = data.probabilities;
    const predicted = data.predicted_class;

    const benignLabel = t.benign || 'Benign';
    const malignantLabel = t.malignant || 'Malignant';
    const segmentationLabel = t.segmentation || 'Segmentation Result';
    const originalLabel = t.original || 'Original Image';
    const modelLabel = t.model || 'Classification Model';
    const predictedLabel = t.predicted || 'Prediction';
    const inputLabel = t.input || 'Input';
    const outputLabel = t.output || 'Output';

    const predLabel = predicted === 1 ? malignantLabel : benignLabel;
    const predClass = predicted === 1 ? 'malignant' : 'benign';

    const segmentationImgSrc = currentClassificationMask ? `data:image/png;base64,${currentClassificationMask}` : '';
    const originalImgSrc = lastInputB64 ? `data:image/png;base64,${lastInputB64}` : '';

    clsBody.innerHTML = `
        <div class="cls-pipeline">
            <!-- Input Images -->
            <div class="cls-input-group">
                <div class="cls-input-card">
                    <div class="cls-input-label">
                        <span class="letter">A</span>
                        ${segmentationLabel}
                    </div>
                    <div class="cls-input-image">
                        ${segmentationImgSrc ? `<img src="${segmentationImgSrc}" alt="Segmentation mask">` : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>'}
                    </div>
                </div>
                <div class="cls-input-card">
                    <div class="cls-input-label">
                        <span class="letter">B</span>
                        ${originalLabel}
                    </div>
                    <div class="cls-input-image">
                        ${originalImgSrc ? `<img src="${originalImgSrc}" alt="Original image">` : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>'}
                    </div>
                </div>
            </div>

            <!-- Arrow 1 -->
            <div class="cls-arrow">
                <div class="cls-arrow-line"></div>
                <span class="cls-arrow-text">${inputLabel}</span>
            </div>

            <!-- AI Model -->
            <div class="cls-model-box">
                <div class="cls-model-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
                    </svg>
                </div>
                <div class="cls-model-label">${modelLabel}</div>
            </div>

            <!-- Arrow 2 -->
            <div class="cls-arrow">
                <div class="cls-arrow-line"></div>
                <span class="cls-arrow-text">${outputLabel}</span>
            </div>

            <!-- Output Probabilities -->
            <div class="cls-output-group">
                <div class="cls-prob-card ${probs[0] >= 50 ? 'highlight highlight-benign' : ''}">
                    <div class="cls-prob-label">
                        <span class="dot benign"></span>
                        ${benignLabel}
                    </div>
                    <div class="cls-prob-bar">
                        <div class="cls-prob-fill benign" style="width: 0%;" data-target="${probs[0]}"></div>
                    </div>
                    <div class="cls-prob-value benign">${probs[0]}%</div>
                </div>
                <div class="cls-prob-card ${probs[1] >= 50 ? 'highlight highlight-malignant' : ''}">
                    <div class="cls-prob-label">
                        <span class="dot malignant"></span>
                        ${malignantLabel}
                    </div>
                    <div class="cls-prob-bar">
                        <div class="cls-prob-fill malignant" style="width: 0%;" data-target="${probs[1]}"></div>
                    </div>
                    <div class="cls-prob-value malignant">${probs[1]}%</div>
                </div>
            </div>

            <!-- Final Prediction -->
            <div class="cls-prediction-final ${predClass}">
                <div class="cls-prediction-icon">
                    ${predClass === 'benign'
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>'
        }
                </div>
                <div class="cls-prediction-text">
                    <div class="cls-prediction-label">${predictedLabel}</div>
                    <div class="cls-prediction-result">${predLabel}</div>
                </div>
            </div>
        </div>`;

    // Animate probability bars
    requestAnimationFrame(() => {
        clsBody.querySelectorAll('.cls-prob-fill').forEach(bar => {
            bar.style.width = bar.dataset.target + '%';
        });
    });
}

async function resizeImageToSquare(file, size = 256) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const side = Math.min(img.width, img.height);
            const sx = (img.width - side) / 2;
            const sy = (img.height - side) / 2;
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
            canvas.toBlob((blob) => resolve(new File([blob], file.name, { type: 'image/png' })), 'image/png');
        };
        img.src = URL.createObjectURL(file);
    });
}

async function classifyImage(file, maskB64, dataset = '', sampleId = '') {
    const form = new FormData();
    form.append('mask_b64', maskB64);
    if (dataset) form.append('dataset', dataset);
    if (sampleId) form.append('sample_id', sampleId);
    else if (file) {
        const resized = await resizeImageToSquare(file);
        form.append('image', resized);
    }

    const resp = await fetch(apiUrl('/api/classify'), { method: 'POST', body: form });
    return await resp.json();
}

// ══════════════════════════════════════════════════════════════════════
// Analysis
// ══════════════════════════════════════════════════════════════════════
const ALL_MODELS = [
    { name: 'Baseline UNet', sliderId: 'slider-baseline', statusId: 'status-baseline', badge: '100%', baseline: true },
    { name: '50% Semi-Supervised', sliderId: 'slider-50pct', statusId: 'status-50pct', badge: '50%' },
    { name: '35% Semi-Supervised', sliderId: 'slider-35pct', statusId: 'status-35pct', badge: '35%' },
    { name: '20% Semi-Supervised', sliderId: 'slider-20pct', statusId: 'status-20pct', badge: '20%' },
    { name: '10% Semi-Supervised', sliderId: 'slider-10pct', statusId: 'status-10pct', badge: '10%' },
    { name: '5% Semi-Supervised', sliderId: 'slider-5pct', statusId: 'status-5pct', badge: '5%' },
];

// Default: the Switch 50% model, displayed generically as "AI model result"
const OUR_MODEL_KEY = '50% Semi-Supervised';

let isFullComparison = false;
let lastAnalysisData = null;

function renderAnalysisGrid() {
    const resultsBody = document.getElementById('resultsBody');

    // Clear any previously rendered comparison cards
    resultsBody.innerHTML = '';

    // Clear slider references for dynamic cards
    allSliders = allSliders.filter(s => {
        const container = s.container;
        // Keep only sliders in static panels (ourModelPanel)
        const ourModelPanel = document.getElementById('ourModelPanel');
        return ourModelPanel.contains(container);
    });

    if (isFullComparison) {
        // Build the expanded comparison grid: Baseline + 5 SonoX models (descending data ratio)
        // Ground Truth card is only shown when a built-in sample is selected (not for user uploads)
        if (currentSampleId) {
            const gtCard = createGtCard();
            resultsBody.appendChild(gtCard);
        }

        ALL_MODELS.forEach(m => {
            const card = createModelCard(m);
            resultsBody.appendChild(card);
        });

        // Re-trigger GT load if a sample was already selected
        if (currentMaskPath && uploadedFile) {
            updateGroundTruth(currentMaskPath, uploadedFile);
        }
    }

    if (lastAnalysisData) {
        populateResults(lastAnalysisData);
    }

    if (translations[currentLang]) {
        applyTranslations(translations[currentLang]);
    }
}

function createGtCard() {
    const card = document.createElement('div');
    card.className = 'result-card';

    card.innerHTML = `
        <div class="model-header">
            <div class="model-title" data-i18n="gt.title">Ground Truth</div>
        </div>
        <div class="img-slider" id="gt-slider">
            <div class="placeholder">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <circle cx="11" cy="11" r="8" />
                    <path d="M21 21l-4.35-4.35" />
                </svg>
                <span data-i18n="gt.placeholder">Select a reference sample to view ground truth</span>
            </div>
        </div>
        <div class="status" id="gt-status"></div>
    `;
    return card;
}

function createModelCard(m) {
    const card = document.createElement('div');
    card.className = 'result-card';

    const titleKey = `models.${m.name}`;
    const badgeClass = m.baseline ? 'model-badge baseline' : 'model-badge';

    card.innerHTML = `
        <div class="model-header">
            <div class="model-title" data-i18n="${titleKey}">${m.name}</div>
            <span class="${badgeClass}">${m.badge}</span>
        </div>
        <div class="img-slider" id="${m.sliderId}">
            <div class="placeholder">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M9 3v18M3 9h18" />
                </svg>
                <span data-i18n="results.placeholder">Upload an image and click Start Analysis</span>
            </div>
        </div>
        <div class="status" id="${m.statusId}" data-model="${m.name}"></div>
    `;
    return card;
}

function populateResults(data) {
    const inputImageB64 = data.input || data.original || '';

    // Populate our model panel (always from Switch 50%)
    const ourModelSlider = document.getElementById('our-model-slider');
    const ourModelStatus = document.getElementById('our-model-status');
    const ourModelResult = data.results.find(r => r.name === OUR_MODEL_KEY);

    if (ourModelResult && ourModelSlider && ourModelStatus) {
        allSliders = allSliders.filter(s => s.container !== ourModelSlider);
        if (ourModelResult.overlay) {
            initSlider(ourModelSlider, inputImageB64, ourModelResult.overlay, 'slider.segmentation');
            currentResultsCoverage[OUR_MODEL_KEY] = ourModelResult.coverage;
            const lesionText = translations[currentLang]?.results?.lesion_area || 'Lesion Area';
            ourModelStatus.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> ${lesionText}: ${ourModelResult.coverage}%`;
        } else {
            ourModelSlider.innerHTML = `<div class="placeholder"><span>${ourModelResult.error || 'No result available'}</span></div>`;
            ourModelStatus.textContent = ourModelResult.error || '';
        }
    }

    // Populate dynamic model cards (full comparison mode)
    for (const result of data.results) {
        const model = ALL_MODELS.find(m => m.name === result.name);
        if (!model) continue;

        const sliderEl = document.getElementById(model.sliderId);
        const statusEl = document.getElementById(model.statusId);
        if (!sliderEl || !statusEl) continue;

        if (result.overlay) {
            initSlider(sliderEl, inputImageB64, result.overlay);
            currentResultsCoverage[result.name] = result.coverage;
            const lesionText = translations[currentLang]?.results?.lesion_area || 'Lesion Area';
            statusEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> ${lesionText}: ${result.coverage}%`;
        } else {
            sliderEl.innerHTML = `<div class="placeholder"><span>${result.error || 'No result available'}</span></div>`;
            statusEl.textContent = result.error || '';
        }
    }
}

document.getElementById('fullCompareBtn').addEventListener('click', () => {
    isFullComparison = !isFullComparison;
    document.getElementById('fullCompareBtn').classList.toggle('active', isFullComparison);
    renderAnalysisGrid();
});

document.getElementById('analyzeBtn').addEventListener('click', async () => {
    if (!uploadedFile) {
        alert(translations[currentLang]?.errors?.no_image || 'Please upload an image or select a reference sample first.');
        return;
    }

    const loading = document.getElementById('loadingOverlay');
    loading.classList.add('active');

    const form = new FormData();
    form.append('dataset', currentDataset);
    if (currentSampleId) form.append('sample_id', currentSampleId);
    else {
        const resized = await resizeImageToSquare(uploadedFile);
        form.append('image', resized);
    }

    try {
        const resp = await fetch(apiUrl('/api/segment'), { method: 'POST', body: form });
        const data = await resp.json();

        if (data.error) {
            loading.classList.remove('active');
            alert('Analysis failed: ' + data.error);
            return;
        }

        lastAnalysisData = data;
        lastInputB64 = data.input || data.original || null;
        currentClassificationMask = data.classification_mask || null;

        renderAnalysisGrid();
        loading.classList.remove('active');  // unhide segmentation results immediately

        // Classification runs after segmentation results are visible
        if (currentClassificationMask) {
            renderClsLoading();
            try {
                const clsResult = await classifyImage(uploadedFile, currentClassificationMask, currentDataset, currentSampleId);
                if (clsResult.error) {
                    renderClsError(clsResult.error);
                } else if (clsResult.skipped) {
                    renderClsNoLesion();
                } else {
                    lastClsResult = clsResult;
                    renderClsPipeline(clsResult);
                }
            } catch (e) {
                console.error('Classification failed:', e);
                renderClsError(e.message);
            }
        }
    } catch (e) {
        loading.classList.remove('active');
        alert('Analysis failed: ' + e.message);
    }
});

// ══════════════════════════════════════════════════════════════════════
// Initialize
// ══════════════════════════════════════════════════════════════════════
const savedLang = localStorage.getItem('sonox-lang') || 'en';
document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === savedLang);
});
loadTranslations(savedLang);
loadExamples('lymph-node');
renderAnalysisGrid();
