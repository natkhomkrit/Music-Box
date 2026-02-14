/**
 * Digital Hand Crank Music Box
 * ----------------------------
 * Two independent progress systems:
 *   - photoProgress: driven by crank rotation (bidirectional)
 *   - audio: plays forward at 1x while cranking (never reverses)
 */

(function () {
    'use strict';

    // ===== CONFIG =====
    const CONFIG = {
        TOTAL_PHOTOS: 27,
        AUDIO_SRC: 'music.mp3',
        FADE_DURATION: 0.25,
        PAUSE_DEBOUNCE: 300,
        WAVEFORM_BARS: 50,
        CRANK_SENSITIVITY: 1.0,
        TOTAL_ANGLE_FOR_FULL: 6480,  // ~18 full rotations = 100% photo progress (27 items)
    };

    // ===== DOM ELEMENTS =====
    const $ = (sel) => document.querySelector(sel);
    const startScreen = $('#startScreen');
    const musicBoxContainer = $('#musicBoxContainer');
    const photoStrip = $('#photoStrip');
    const crankArea = $('#crankArea');
    const crankHandle = $('#crankHandle');
    const crankInstruction = $('#crankInstruction');
    const waveformBarsContainer = $('#waveformBars');
    const currentTimeEl = $('#currentTime');
    const totalTimeEl = $('#totalTime');
    const finalReveal = $('#finalReveal');
    const replayBtn = $('#replayBtn');
    const particlesContainer = $('#particlesContainer');
    const paperOutputStrip = $('#paperOutputStrip');

    // ===== STATE =====
    let state = {
        started: false,

        // Photo progress — driven by crank angle (0 to 1, bidirectional)
        photoProgress: 0,
        crankAngle: 0,

        // Audio — simply plays forward at 1x while cranking
        audioReady: false,
        isPlaying: false,

        // Crank interaction
        isDragging: false,
        isCranking: false,
        lastPointerAngle: null,
        crankVisualAngle: 0,

        revealed: false,
        pauseTimeout: null,
    };

    // ===== AUDIO SETUP =====
    let audioContext = null;
    let analyserNode = null;
    let audioElement = null;
    let mediaSource = null;

    function initAudio() {
        audioElement = new Audio(CONFIG.AUDIO_SRC);
        audioElement.preload = 'auto';
        audioElement.loop = false;
        audioElement.volume = 1;

        audioElement.addEventListener('canplaythrough', () => {
            if (!state.audioReady) {
                state.audioReady = true;
                updateTotalTime();
            }
        });

        audioElement.addEventListener('ended', () => {
            state.isPlaying = false;
            if (!state.revealed) {
                showFinalReveal();
            }
        });

        audioElement.addEventListener('error', () => {
            console.warn('Audio file not found. Place music.mp3 in the valentine folder.');
            state.audioReady = true;
        });
    }

    // Connect Web Audio API for waveform analysis (lazy, non-blocking)
    function connectAnalyser() {
        if (analyserNode || !audioElement) return;
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            analyserNode = audioContext.createAnalyser();
            analyserNode.fftSize = 128;
            mediaSource = audioContext.createMediaElementSource(audioElement);
            mediaSource.connect(analyserNode);
            analyserNode.connect(audioContext.destination);
            if (audioContext.state === 'suspended') {
                audioContext.resume();
            }
        } catch (e) {
            console.warn('Web Audio API not available, waveform disabled.');
            analyserNode = null;
        }
    }

    function updateTotalTime() {
        if (audioElement && audioElement.duration && isFinite(audioElement.duration)) {
            totalTimeEl.textContent = formatTime(audioElement.duration);
        }
    }

    function formatTime(seconds) {
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    // ===== AUDIO CONTROL =====
    // Play at 1x forward only — cranking in any direction triggers play
    function startAudioPlayback() {
        if (!state.audioReady || !audioElement) return;

        if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume();
        }

        if (state.pauseTimeout) {
            clearTimeout(state.pauseTimeout);
            state.pauseTimeout = null;
        }

        if (!state.isPlaying) {
            audioElement.volume = 1;
            audioElement.play().catch(() => { });
            state.isPlaying = true;
        }
    }

    function scheduleAudioPause() {
        if (state.pauseTimeout) {
            clearTimeout(state.pauseTimeout);
        }

        state.pauseTimeout = setTimeout(() => {
            if (state.isPlaying && !state.isCranking) {
                // Fade out using volume
                let vol = audioElement.volume;
                const fadeInterval = setInterval(() => {
                    vol -= 0.1;
                    if (vol <= 0) {
                        vol = 0;
                        clearInterval(fadeInterval);
                        audioElement.pause();
                        state.isPlaying = false;
                        audioElement.volume = 1;
                    }
                    audioElement.volume = Math.max(0, vol);
                }, CONFIG.FADE_DURATION * 100);
            }
        }, CONFIG.PAUSE_DEBOUNCE);
    }

    // ===== WAVEFORM =====
    function initWaveform() {
        waveformBarsContainer.innerHTML = '';
        for (let i = 0; i < CONFIG.WAVEFORM_BARS; i++) {
            const bar = document.createElement('div');
            bar.className = 'bar';
            bar.style.height = '3px';
            waveformBarsContainer.appendChild(bar);
        }
    }

    function updateWaveform() {
        if (!analyserNode) return;

        const bars = waveformBarsContainer.querySelectorAll('.bar');
        const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
        analyserNode.getByteFrequencyData(dataArray);

        const barCount = bars.length;
        const step = Math.floor(dataArray.length / barCount);

        // Use audio progress for waveform active state
        const audioProgress = getAudioProgress();

        for (let i = 0; i < barCount; i++) {
            const value = dataArray[i * step] || 0;
            const height = Math.max(3, (value / 255) * 40);
            bars[i].style.height = height + 'px';

            const barProgress = i / barCount;
            if (barProgress <= audioProgress && state.isPlaying) {
                bars[i].classList.add('active');
            } else {
                bars[i].classList.remove('active');
            }
        }
    }

    function animateWaveformIdle() {
        const bars = waveformBarsContainer.querySelectorAll('.bar');
        bars.forEach((bar, i) => {
            const h = 3 + Math.sin(Date.now() / 500 + i * 0.3) * 2;
            bar.style.height = h + 'px';
            bar.classList.remove('active');
        });
    }

    function getAudioProgress() {
        if (!audioElement || !audioElement.duration || !isFinite(audioElement.duration)) return 0;
        return audioElement.currentTime / audioElement.duration;
    }

    // ===== CRANK INTERACTION =====
    function getPointerAngle(e, rect) {
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const dx = e.clientX - centerX;
        const dy = e.clientY - centerY;
        return Math.atan2(dy, dx) * (180 / Math.PI);
    }

    function onCrankPointerDown(e) {
        if (state.revealed) return;
        e.preventDefault();
        state.isDragging = true;

        // Resume audio context on user gesture (required for mobile)
        if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume();
        }

        const rect = crankArea.getBoundingClientRect();
        state.lastPointerAngle = getPointerAngle(e, rect);

        crankArea.setPointerCapture(e.pointerId);

        if (crankInstruction.style.opacity !== '0') {
            crankInstruction.style.transition = 'opacity 0.5s';
            crankInstruction.style.opacity = '0';
        }
    }

    function onCrankPointerMove(e) {
        if (!state.isDragging || state.revealed) return;
        e.preventDefault();

        const rect = crankArea.getBoundingClientRect();
        const currentAngle = getPointerAngle(e, rect);

        if (state.lastPointerAngle !== null) {
            let delta = currentAngle - state.lastPointerAngle;

            // Handle crossing -180/180 boundary
            if (delta > 180) delta -= 360;
            if (delta < -180) delta += 360;

            delta *= CONFIG.CRANK_SENSITIVITY;

            // Update crank angle (cumulative, can go negative)
            state.crankAngle += delta;

            // Photo progress driven by crank (0 to 1, clamped)
            state.photoProgress = Math.max(0, Math.min(1,
                state.crankAngle / CONFIG.TOTAL_ANGLE_FOR_FULL
            ));

            // Update crank visual
            state.crankVisualAngle += delta;
            crankHandle.style.transform = `rotate(${state.crankVisualAngle}deg)`;

            // Update photo strip and paper feed (driven by crank)
            updatePhotoStrip();
            updatePaperFeed();

            // Trigger audio — cranking in ANY direction plays music forward
            if (Math.abs(delta) > 0.5) {
                state.isCranking = true;
                startAudioPlayback();
            }
        }

        state.lastPointerAngle = currentAngle;
    }

    function onCrankPointerUp(e) {
        if (!state.isDragging) return;
        state.isDragging = false;
        state.isCranking = false;
        state.lastPointerAngle = null;

        scheduleAudioPause();
    }

    // ===== FLIPBOOK / PHOTO STRIP (crank-driven) =====
    function updatePhotoStrip() {
        const items = photoStrip.querySelectorAll('.photo-item');
        if (items.length === 0) return;
        const firstItem = items[0];
        const style = getComputedStyle(firstItem);
        const itemHeight = firstItem.offsetHeight + parseFloat(style.marginBottom || 0);
        const totalScrollHeight = itemHeight * (items.length - 1);
        const offset = -state.photoProgress * totalScrollHeight;
        photoStrip.style.transform = `translateY(${offset}px)`;
    }

    // ===== THUMBNAIL STRIP (crank-driven, horizontal) =====
    function updatePaperFeed() {
        const miniPhotos = paperOutputStrip.querySelectorAll('.paper-mini-photo');
        if (miniPhotos.length === 0) return;

        const firstMini = miniPhotos[0];
        const miniWidth = firstMini.offsetWidth + 3; // width + gap
        const totalScrollWidth = miniWidth * (miniPhotos.length - 1);
        const containerWidth = paperOutputStrip.parentElement.offsetWidth;
        const maxScroll = Math.max(0, (miniWidth * miniPhotos.length + 8) - containerWidth);
        const offset = -state.photoProgress * maxScroll;

        paperOutputStrip.style.transform = `translateX(${offset}px)`;
    }


    function initPaperOutputStrip() {
        paperOutputStrip.innerHTML = '';
        const photoItems = photoStrip.querySelectorAll('.photo-item');
        photoItems.forEach((item) => {
            const img = item.querySelector('img');
            if (!img) return; // skip non-image slides (e.g. final message)
            const mini = document.createElement('div');
            mini.className = 'paper-mini-photo';
            const miniImg = document.createElement('img');
            miniImg.src = img.src;
            miniImg.alt = img.alt;
            mini.appendChild(miniImg);
            paperOutputStrip.appendChild(mini);
        });
    }

    // ===== FINAL REVEAL =====
    function showFinalReveal() {
        state.revealed = true;

        if (state.isPlaying && audioElement) {
            gainNode.gain.cancelScheduledValues(audioContext.currentTime);
            gainNode.gain.linearRampToValueAtTime(0.001, audioContext.currentTime + 0.5);
            setTimeout(() => {
                audioElement.pause();
                state.isPlaying = false;
            }, 600);
        }

        setTimeout(() => {
            finalReveal.classList.remove('hidden');
            spawnParticles();
        }, 400);
    }

    function spawnParticles() {
        const hearts = ['❤️', '💕', '💖', '💗', '✨', '💘', '💝', '🌸', '🩷'];
        const totalParticles = 40;

        for (let i = 0; i < totalParticles; i++) {
            setTimeout(() => {
                const particle = document.createElement('div');
                particle.className = 'particle';
                particle.textContent = hearts[Math.floor(Math.random() * hearts.length)];
                particle.style.left = Math.random() * 100 + '%';
                particle.style.fontSize = (0.8 + Math.random() * 1.5) + 'rem';
                particle.style.animationDuration = (3 + Math.random() * 4) + 's';
                particle.style.animationDelay = '0s';
                particlesContainer.appendChild(particle);

                setTimeout(() => particle.remove(), 7000);
            }, i * 120);
        }
    }

    // ===== REPLAY =====
    function resetApp() {
        state.photoProgress = 0;
        state.crankAngle = 0;
        state.crankVisualAngle = 0;
        state.revealed = false;
        state.isDragging = false;
        state.isCranking = false;
        state.lastPointerAngle = null;
        state.isPlaying = false;

        crankHandle.style.transform = 'rotate(0deg)';
        photoStrip.style.transform = 'translateY(0)';
        paperOutputStrip.style.transform = 'translateX(0)';
        crankInstruction.style.opacity = '1';
        currentTimeEl.textContent = '0:00';


        if (audioElement) {
            audioElement.pause();
            audioElement.currentTime = 0;
        }

        finalReveal.classList.add('hidden');
        particlesContainer.innerHTML = '';

        animateWaveformIdle();
    }

    // ===== ANIMATION LOOP =====
    function animationLoop() {
        if (state.isPlaying) {
            updateWaveform();
            if (audioElement && audioElement.duration) {
                currentTimeEl.textContent = formatTime(audioElement.currentTime);
            }
        } else if (!state.revealed) {
            animateWaveformIdle();
        }

        requestAnimationFrame(animationLoop);
    }

    // ===== START SCREEN =====
    function handleStart() {
        if (state.started) return;
        state.started = true;

        initAudio();
        connectAnalyser();

        // Resume AudioContext + unlock audio on mobile (must happen inside user gesture)
        if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume();
        }
        if (audioElement) {
            audioElement.play().then(() => {
                audioElement.pause();
                audioElement.currentTime = 0;
            }).catch(() => { });
        }

        startScreen.style.transition = 'opacity 0.6s ease-out';
        startScreen.style.opacity = '0';

        setTimeout(() => {
            startScreen.classList.add('hidden');
            musicBoxContainer.classList.remove('hidden');
        }, 600);
    }

    // ===== INIT =====
    function init() {
        initWaveform();
        initPaperOutputStrip();

        startScreen.addEventListener('click', handleStart);
        startScreen.addEventListener('touchend', (e) => {
            e.preventDefault();
            handleStart();
        });

        crankArea.addEventListener('pointerdown', onCrankPointerDown);
        crankArea.addEventListener('pointermove', onCrankPointerMove);
        crankArea.addEventListener('pointerup', onCrankPointerUp);
        crankArea.addEventListener('pointercancel', onCrankPointerUp);

        replayBtn.addEventListener('click', resetApp);

        animationLoop();

        document.addEventListener('touchmove', (e) => {
            if (state.isDragging) e.preventDefault();
        }, { passive: false });

        console.log('🎵 Music Box initialized. Place music.mp3 in the valentine folder.');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
