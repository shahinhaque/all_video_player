import { resolveUrl, PROVIDERS } from '../providers/index.js';
import { createLocalPlaylist } from '../providers/local.js';
import { PlaylistManager } from '../core/playlist.js';
import { createPlaybackEngine } from '../engines/index.js';
import { PlaybackEngine, MediaItem, SubtitleTrackInfo, RangeByteSource } from '../core/types.js';
import { formatTime, formatBytes, readAll } from '../lib/util.js';
import { toPlayerError } from '../core/errors.js';
import { createSubtitleTrackUrl, isSubtitleName } from '../lib/subtitles.js';
import { PrefetchedByteSource } from '../lib/network.js';
import { ext } from '../lib/browser.js';

class PlayerController {
  private video = document.getElementById('video-element') as HTMLVideoElement;
  private drivePreviewFrame = document.getElementById('drive-preview-frame') as HTMLIFrameElement;
  private wrapper = document.querySelector('.video-wrapper') as HTMLElement;
  private currentTitle = document.getElementById('current-title') as HTMLElement;
  private codecPill = document.getElementById('codec-pill') as HTMLElement;
  private speedPill = document.getElementById('speed-pill') as HTMLElement;
  private centerIndicator = document.getElementById('center-indicator') as HTMLElement;
  private alertToast = document.getElementById('alert-toast') as HTMLElement;
  private alertText = document.getElementById('alert-text') as HTMLElement;
  private alertDismiss = document.getElementById('alert-dismiss') as HTMLElement;
  private warningBanner = document.getElementById('warning-banner') as HTMLElement;
  private warningText = document.getElementById('warning-text') as HTMLElement;
  private warningDismiss = document.getElementById('warning-dismiss') as HTMLElement;

  private timelineContainer = document.querySelector('.timeline-container') as HTMLElement;
  private timelineProgress = document.getElementById('timeline-progress') as HTMLElement;
  private bufferedBar = document.getElementById('buffered-bar') as HTMLElement;
  private playedBar = document.getElementById('played-bar') as HTMLElement;
  private seekThumb = document.getElementById('seek-thumb') as HTMLElement;
  private timelineTooltip = document.getElementById('timeline-tooltip') as HTMLElement;
  private isDraggingTimeline = false;
  private wasPlayingBeforeDrag = false;

  private btnPlayPause = document.getElementById('btn-play-pause') as HTMLElement;
  private iconPlay = document.getElementById('icon-play') as HTMLElement;
  private iconPause = document.getElementById('icon-pause') as HTMLElement;
  private btnPrev = document.getElementById('btn-prev') as HTMLButtonElement;
  private btnNext = document.getElementById('btn-next') as HTMLButtonElement;

  private btnMute = document.getElementById('btn-mute') as HTMLElement;
  private iconVolHigh = document.getElementById('icon-vol-high') as HTMLElement;
  private iconVolMute = document.getElementById('icon-vol-mute') as HTMLElement;
  private volumeSlider = document.getElementById('volume-slider') as HTMLInputElement;

  private timeCurrent = document.getElementById('time-current') as HTMLElement;
  private timeDuration = document.getElementById('time-duration') as HTMLElement;

  private btnSpeed = document.getElementById('btn-speed') as HTMLElement;
  private speedMenu = document.getElementById('speed-menu') as HTMLElement;
  private btnCc = document.getElementById('btn-cc') as HTMLElement;
  private btnPip = document.getElementById('btn-pip') as HTMLElement;
  private btnFullscreen = document.getElementById('btn-fullscreen') as HTMLElement;
  private iconFsEnter = document.getElementById('icon-fs-enter') as HTMLElement;
  private iconFsExit = document.getElementById('icon-fs-exit') as HTMLElement;
  private dropOverlay = document.getElementById('drop-overlay') as HTMLElement;

  private btnOpenFile = document.getElementById('btn-open-file') as HTMLElement;
  private filePickerInput = document.getElementById('file-picker-input') as HTMLInputElement;

  private btnShortcuts = document.getElementById('btn-shortcuts') as HTMLElement;
  private shortcutsModal = document.getElementById('shortcuts-modal') as HTMLElement;
  private btnCloseShortcuts = document.getElementById('btn-close-shortcuts') as HTMLElement;

  private btnTogglePlaylist = document.getElementById('btn-toggle-playlist') as HTMLElement;
  private btnClosePlaylist = document.getElementById('btn-close-playlist') as HTMLElement;
  private playlistSidebar = document.getElementById('playlist-sidebar') as HTMLElement;
  private playlistItemsContainer = document.getElementById('playlist-items') as HTMLElement;
  private playlistCount = document.getElementById('playlist-count') as HTMLElement;
  private playlistBadge = document.getElementById('playlist-badge') as HTMLElement;
  private chkAutoNext = document.getElementById('chk-auto-next') as HTMLInputElement;

  private playlistManager: PlaylistManager | null = null;
  private currentEngine: PlaybackEngine | null = null;
  private preferredChunkSize = 2097152;
  private hideControlsTimer: number | null = null;
  private savePositionInterval: number | null = null;
  private activeSubTrack: HTMLTrackElement | null = null;
  private prefetchedNext: {
    itemId: string;
    source: RangeByteSource;
    abortController: AbortController;
  } | null = null;
  private isPrefetchingNext = false;

  async init(): Promise<void> {
    this.setupEventListeners();
    this.setupKeyboardShortcuts();

    // Load user preferences
    try {
      const data = await ext.storage.local.get(['settings', 'volume', 'muted']);
      const s = data?.settings;
      if (s?.defaultSpeed && s.defaultSpeed !== 1.0) {
        this.setSpeed(s.defaultSpeed);
      }
      if (s?.autoNext !== undefined && this.chkAutoNext) {
        this.chkAutoNext.checked = s.autoNext;
        this.playlistManager?.setAutoNext(s.autoNext);
      }
      if (s?.chunkSize) {
        this.preferredChunkSize = s.chunkSize;
      }
      if (typeof data?.volume === 'number') {
        this.video.volume = data.volume;
        this.volumeSlider.value = String(data.volume);
      }
      if (typeof data?.muted === 'boolean') {
        this.video.muted = data.muted;
        this.updateVolumeIcons();
      }
    } catch {}

    const params = new URLSearchParams(window.location.search);
    const mediaUrl = params.get('url');

    if (mediaUrl) {
      await this.loadUrl(mediaUrl);
    } else {
      this.showAlert('No media link provided. Paste a link from the popup or extension menu.');
    }
  }

  async loadUrl(url: string): Promise<void> {
    this.showBuffering(true);
    try {
      const playlist = await resolveUrl(url);
      this.playlistManager = new PlaylistManager(playlist);
      this.renderPlaylist();
      await this.playItem(this.playlistManager.currentItem);
    } catch (err) {
      this.showBuffering(false);
      const pe = toPlayerError(err);
      this.showAlert(pe.message);
    }
  }

  async playItem(item: MediaItem | undefined): Promise<void> {
    if (!item || !this.playlistManager) return;
    this.showBuffering(true);
    this.currentTitle.textContent = item.name;
    this.currentTitle.title = item.name;
    this.updatePlaylistUI();

    // Reset UI alerts
    if (this.alertToast) this.alertToast.hidden = true;
    if (this.warningBanner) this.warningBanner.hidden = true;

    // Clean up previous subtitle track
    if (this.activeSubTrack) {
      this.activeSubTrack.remove();
      this.activeSubTrack = null;
      this.btnCc.classList.remove('active');
    }

    // Reset preview frame when playing new item
    if (this.drivePreviewFrame) {
      this.drivePreviewFrame.hidden = true;
      this.drivePreviewFrame.src = 'about:blank';
    }
    this.video.hidden = false;

    // Clean up previous engine
    if (this.currentEngine) {
      this.currentEngine.destroy();
      this.currentEngine = null;
    }

    try {
      let source: RangeByteSource;
      if (this.prefetchedNext && this.prefetchedNext.itemId === item.id) {
        source = this.prefetchedNext.source;
        this.prefetchedNext = null;
      } else {
        if (this.prefetchedNext) {
          this.prefetchedNext.abortController.abort();
          this.prefetchedNext = null;
        }
        const provider = PROVIDERS.find((p) => p.id === item.provider);
        if (!provider) throw new Error(`Provider not found: ${item.provider}`);
        source = await provider.open(item);
      }
      const host = {
        warn: (msg: string) => this.showWarning(msg),
        fail: (err: unknown) => {
          const pe = toPlayerError(err);
          // If native video playback failed on Google Drive, fallback to Drive preview player
          if (item.provider === 'gdrive' && this.drivePreviewFrame && !this.drivePreviewFrame.src.includes('drive.google.com')) {
            console.warn('Native playback failed on Google Drive, activating Drive preview player fallback');
            this.activateDrivePreview(item);
            return;
          }
          this.showAlert(pe.message);
        },
      };

      const { engine, container } = await createPlaybackEngine(this.video, source, host, {
        chunkSize: this.preferredChunkSize,
      });
      this.currentEngine = engine;

      this.codecPill.hidden = false;
      this.codecPill.textContent = container;

      // Check saved resume position if enabled in settings
      let savedSec = 0;
      try {
        const s = (await ext.storage.local.get('settings'))?.settings;
        if (s?.resumePlayback !== false) {
          savedSec = await this.playlistManager.getSavedPosition(item);
        }
      } catch {
        savedSec = await this.playlistManager.getSavedPosition(item);
      }
      await engine.attach(savedSec);

      // Auto-load companion subtitles if present
      if (item.subtitles && item.subtitles.length > 0) {
        this.loadCompanionSubtitle(item.subtitles[0]);
      }

      this.video.play().catch(() => {
        // Autoplay policy might require interaction
      });

      this.setupMediaSession();
      this.startPositionSaver();
    } catch (err) {
      const pe = toPlayerError(err);
      this.showAlert(pe.message);
    } finally {
      this.showBuffering(false);
    }
  }

  private activateDrivePreview(item: MediaItem): void {
    const fileId = item.ref?.fileId || item.id;
    if (this.currentEngine) {
      this.currentEngine.destroy();
      this.currentEngine = null;
    }
    this.video.hidden = true;
    this.drivePreviewFrame.hidden = false;
    this.drivePreviewFrame.src = `https://drive.google.com/file/d/${fileId}/preview`;
    this.codecPill.hidden = false;
    this.codecPill.textContent = 'DRIVE STREAM (MKV)';
    this.showBuffering(false);
  }

  private setupEventListeners(): void {
    // Play / Pause
    this.btnPlayPause.addEventListener('click', () => this.togglePlay());
    this.video.addEventListener('click', () => this.togglePlay());
    this.video.addEventListener('play', () => this.updatePlayPauseIcon(true));
    this.video.addEventListener('pause', () => this.updatePlayPauseIcon(false));

    // Next / Previous
    this.btnNext.addEventListener('click', () => this.playNext());
    this.btnPrev.addEventListener('click', () => this.playPrevious());

    // Auto-advance on video end
    this.video.addEventListener('ended', () => {
      if (this.playlistManager?.isAutoNext() && this.playlistManager.hasNext()) {
        this.playNext();
      }
    });

    // Time & Progress update
    this.video.addEventListener('timeupdate', () => this.onTimeUpdate());
    this.video.addEventListener('progress', () => this.onProgress());
    this.video.addEventListener('waiting', () => this.showBuffering(true));
    this.video.addEventListener('playing', () => this.showBuffering(false));

    // Timeline seeking & pulling (drag support)
    this.timelineProgress.addEventListener('mousedown', (e) => this.onTimelineDragStart(e));
    this.timelineProgress.addEventListener('touchstart', (e) => this.onTimelineTouchStart(e), { passive: true });
    this.timelineProgress.addEventListener('mousemove', (e) => this.hoverTimeline(e));

    window.addEventListener('mousemove', (e) => this.onTimelineDragMove(e));
    window.addEventListener('touchmove', (e) => this.onTimelineTouchMove(e), { passive: true });
    window.addEventListener('mouseup', (e) => this.onTimelineDragEnd(e));
    window.addEventListener('touchend', (e) => this.onTimelineTouchEnd(e));

    // Volume
    this.volumeSlider.addEventListener('input', () => {
      this.video.volume = parseFloat(this.volumeSlider.value);
      this.video.muted = this.video.volume === 0;
      this.updateVolumeIcons();
      ext.storage.local.set({ volume: this.video.volume, muted: this.video.muted }).catch(() => {});
    });
    this.btnMute.addEventListener('click', () => {
      this.video.muted = !this.video.muted;
      this.updateVolumeIcons();
      ext.storage.local.set({ muted: this.video.muted }).catch(() => {});
    });

    // Speed menu
    this.btnSpeed.addEventListener('click', (e) => {
      e.stopPropagation();
      this.speedMenu.hidden = !this.speedMenu.hidden;
    });
    this.speedMenu.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const speed = target.dataset.speed;
      if (speed) {
        this.setSpeed(parseFloat(speed));
        this.speedMenu.hidden = true;
      }
    });
    document.addEventListener('click', () => {
      if (!this.speedMenu.hidden) this.speedMenu.hidden = true;
    });

    // Subtitles (CC)
    this.btnCc.addEventListener('click', () => this.toggleSubtitles());

    // PiP & Fullscreen
    this.btnPip.addEventListener('click', () => this.togglePiP());
    this.btnFullscreen.addEventListener('click', () => this.toggleFullscreen());
    document.addEventListener('fullscreenchange', () => {
      const isFs = !!document.fullscreenElement;
      this.iconFsEnter.hidden = isFs;
      this.iconFsExit.hidden = !isFs;
    });

    // Local file picker
    this.btnOpenFile.addEventListener('click', () => {
      this.filePickerInput.click();
    });
    this.filePickerInput.addEventListener('change', () => {
      const files = Array.from(this.filePickerInput.files || []);
      if (files.length > 0) this.handleDroppedFiles(files);
      this.filePickerInput.value = '';
    });

    // Drag and drop
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.dropOverlay.hidden = false;
    });
    window.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) this.dropOverlay.hidden = true;
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dropOverlay.hidden = true;
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length > 0) this.handleDroppedFiles(files);
    });

    // Playlist sidebar toggle
    this.btnTogglePlaylist.addEventListener('click', () => {
      this.playlistSidebar.classList.toggle('collapsed');
    });
    this.btnClosePlaylist.addEventListener('click', () => {
      this.playlistSidebar.classList.add('collapsed');
    });
    this.chkAutoNext.addEventListener('change', () => {
      this.playlistManager?.setAutoNext(this.chkAutoNext.checked);
    });

    // Controls autohide on mouse idle
    this.wrapper.addEventListener('mousemove', () => this.resetControlsTimer());
    this.wrapper.addEventListener('mouseenter', () => this.resetControlsTimer());
    this.wrapper.addEventListener('mouseleave', () => this.wrapper.classList.remove('show-controls'));

    // Keyboard shortcuts modal
    if (this.btnShortcuts && this.shortcutsModal) {
      this.btnShortcuts.addEventListener('click', () => {
        this.shortcutsModal.hidden = !this.shortcutsModal.hidden;
      });
      if (this.btnCloseShortcuts) {
        this.btnCloseShortcuts.addEventListener('click', () => {
          this.shortcutsModal.hidden = true;
        });
      }
      this.shortcutsModal.addEventListener('click', (e) => {
        if (e.target === this.shortcutsModal) {
          this.shortcutsModal.hidden = true;
        }
      });
    }

    // Toast & Warning dismiss
    this.alertDismiss?.addEventListener('click', () => {
      this.alertToast.hidden = true;
    });
    this.warningDismiss?.addEventListener('click', () => {
      this.warningBanner.hidden = true;
    });
  }

  private setupKeyboardShortcuts(): void {
    document.addEventListener('keydown', (e) => {
      // Ignore if user is in an input
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;

      switch (e.key) {
        case '?':
          if (this.shortcutsModal) {
            this.shortcutsModal.hidden = !this.shortcutsModal.hidden;
          }
          break;
        case 'Escape':
          if (this.shortcutsModal && !this.shortcutsModal.hidden) {
            this.shortcutsModal.hidden = true;
          }
          break;
        case ' ':
          e.preventDefault();
          this.togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          this.video.currentTime = Math.max(0, this.video.currentTime - 5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          this.video.currentTime = Math.min(this.video.duration || Infinity, this.video.currentTime + 5);
          break;
        case 'j':
        case 'J':
          this.video.currentTime = Math.max(0, this.video.currentTime - 10);
          break;
        case 'l':
        case 'L':
          this.video.currentTime = Math.min(this.video.duration || Infinity, this.video.currentTime + 10);
          break;
        case 'ArrowUp':
          e.preventDefault();
          this.video.volume = Math.min(1, this.video.volume + 0.05);
          this.volumeSlider.value = String(this.video.volume);
          this.updateVolumeIcons();
          break;
        case 'ArrowDown':
          e.preventDefault();
          this.video.volume = Math.max(0, this.video.volume - 0.05);
          this.volumeSlider.value = String(this.video.volume);
          this.updateVolumeIcons();
          break;
        case 'm':
        case 'M':
          this.video.muted = !this.video.muted;
          this.updateVolumeIcons();
          break;
        case 'f':
        case 'F':
          this.toggleFullscreen();
          break;
        case 'p':
        case 'P':
          if (e.shiftKey) {
            this.playPrevious();
          } else {
            this.togglePiP();
          }
          break;
        case 'c':
        case 'C':
          this.toggleSubtitles();
          break;
        case 'n':
        case 'N':
          if (e.shiftKey) this.playNext();
          break;
      }
    });
  }

  private togglePlay(): void {
    if (this.video.paused) {
      this.video.play();
    } else {
      this.video.pause();
    }
  }

  private updatePlayPauseIcon(isPlaying: boolean): void {
    this.iconPlay.hidden = isPlaying;
    this.iconPause.hidden = !isPlaying;
  }

  private playNext(): void {
    if (!this.playlistManager) return;

    if (this.playlistManager.count <= 1) {
      this.showAlert('Only 1 video in current playlist.');
      return;
    }

    if (this.playlistManager.hasNext()) {
      const nextItem = this.playlistManager.next();
      if (nextItem) this.playItem(nextItem);
    } else {
      // Reached the end of playlist -> loop back to first track
      const firstItem = this.playlistManager.setIndex(0);
      if (firstItem) {
        this.showAlert('Reached end of playlist. Restarting from first video.');
        this.playItem(firstItem);
      }
    }
  }

  private playPrevious(): void {
    if (!this.playlistManager) return;

    if (this.playlistManager.count <= 1) {
      this.video.currentTime = 0;
      this.showAlert('Single video — restarted from beginning.');
      return;
    }

    if (this.video.currentTime > 3) {
      // If playback is more than 3 seconds in, restart current track
      this.video.currentTime = 0;
      return;
    }

    if (this.playlistManager.hasPrev()) {
      const prevItem = this.playlistManager.prev();
      if (prevItem) this.playItem(prevItem);
    } else {
      // At the start -> loop to last video in playlist
      const lastItem = this.playlistManager.setIndex(this.playlistManager.count - 1);
      if (lastItem) {
        this.showAlert('Looping to last video in playlist.');
        this.playItem(lastItem);
      }
    }
  }

  private onTimeUpdate(): void {
    if (this.isDraggingTimeline) return;
    const cur = this.video.currentTime;
    const dur = this.video.duration || 0;
    this.timeCurrent.textContent = formatTime(cur);
    this.timeDuration.textContent = formatTime(dur);

    if (dur > 0) {
      const pct = (cur / dur) * 100;
      this.playedBar.style.width = `${pct}%`;
      this.seekThumb.style.left = `${pct}%`;

      // Pre-resolve next item and prefetch initial 1 MB at 80% progress
      if (
        cur / dur >= 0.8 &&
        !this.isPrefetchingNext &&
        this.playlistManager?.hasNext() &&
        this.playlistManager.isAutoNext()
      ) {
        const nextItem = this.playlistManager.items[this.playlistManager.currentIndex + 1];
        if (nextItem && (!this.prefetchedNext || this.prefetchedNext.itemId !== nextItem.id)) {
          this.prefetchNextItem(nextItem);
        }
      }
    }
  }

  private async prefetchNextItem(nextItem: MediaItem): Promise<void> {
    this.isPrefetchingNext = true;
    const ac = new AbortController();
    try {
      const provider = PROVIDERS.find((p) => p.id === nextItem.provider);
      if (!provider) return;
      const baseSource = await provider.open(nextItem);
      const prefetchLen = Math.min(1024 * 1024, baseSource.size > 0 ? baseSource.size : 1024 * 1024);
      const stream = await baseSource.read(0, prefetchLen - 1, ac.signal);
      const bytes = await readAll(stream);
      if (!ac.signal.aborted) {
        this.prefetchedNext = {
          itemId: nextItem.id,
          source: new PrefetchedByteSource(baseSource, 0, bytes),
          abortController: ac,
        };
      }
    } catch {
      // Background prefetch error is non-fatal
    } finally {
      this.isPrefetchingNext = false;
    }
  }

  private onProgress(): void {
    const dur = this.video.duration || 0;
    const ranges = this.video.buffered;
    if (ranges.length > 0 && dur > 0) {
      const end = ranges.end(ranges.length - 1);
      const pct = (end / dur) * 100;
      this.bufferedBar.style.width = `${pct}%`;
    }
  }

  private onTimelineDragStart(e: MouseEvent): void {
    if (e.button !== 0) return;
    this.isDraggingTimeline = true;
    this.wasPlayingBeforeDrag = !this.video.paused;
    this.video.pause();
    this.timelineContainer?.classList.add('is-dragging');
    this.updateTimelineFromPosition(e.clientX);
  }

  private onTimelineTouchStart(e: TouchEvent): void {
    if (e.touches.length === 0) return;
    this.isDraggingTimeline = true;
    this.wasPlayingBeforeDrag = !this.video.paused;
    this.video.pause();
    this.timelineContainer?.classList.add('is-dragging');
    this.updateTimelineFromPosition(e.touches[0].clientX);
  }

  private onTimelineDragMove(e: MouseEvent): void {
    if (!this.isDraggingTimeline) return;
    this.updateTimelineFromPosition(e.clientX);
  }

  private onTimelineTouchMove(e: TouchEvent): void {
    if (!this.isDraggingTimeline || e.touches.length === 0) return;
    this.updateTimelineFromPosition(e.touches[0].clientX);
  }

  private onTimelineDragEnd(e: MouseEvent): void {
    if (!this.isDraggingTimeline) return;
    this.isDraggingTimeline = false;
    this.timelineContainer?.classList.remove('is-dragging');
    const targetTime = this.updateTimelineFromPosition(e.clientX);
    const dur = this.video.duration;
    if (dur && Number.isFinite(dur)) {
      this.video.currentTime = targetTime;
    }
    if (this.wasPlayingBeforeDrag) {
      this.video.play().catch(() => {});
    }
  }

  private onTimelineTouchEnd(e: TouchEvent): void {
    if (!this.isDraggingTimeline) return;
    this.isDraggingTimeline = false;
    this.timelineContainer?.classList.remove('is-dragging');
    const touch = e.changedTouches[0];
    if (touch) {
      const targetTime = this.updateTimelineFromPosition(touch.clientX);
      const dur = this.video.duration;
      if (dur && Number.isFinite(dur)) {
        this.video.currentTime = targetTime;
      }
    }
    if (this.wasPlayingBeforeDrag) {
      this.video.play().catch(() => {});
    }
  }

  private updateTimelineFromPosition(clientX: number): number {
    const rect = this.timelineProgress.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const dur = this.video.duration || 0;
    const targetTime = pos * dur;

    this.playedBar.style.width = `${pos * 100}%`;
    this.seekThumb.style.left = `${pos * 100}%`;
    this.timeCurrent.textContent = formatTime(targetTime);
    this.timelineTooltip.style.left = `${pos * 100}%`;
    this.timelineTooltip.textContent = formatTime(targetTime);

    return targetTime;
  }

  private hoverTimeline(e: MouseEvent): void {
    if (this.isDraggingTimeline) return;
    const rect = this.timelineProgress.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const dur = this.video.duration || 0;
    this.timelineTooltip.style.left = `${pos * 100}%`;
    this.timelineTooltip.textContent = formatTime(pos * dur);
  }

  private updateVolumeIcons(): void {
    const muted = this.video.muted || this.video.volume === 0;
    this.iconVolHigh.hidden = muted;
    this.iconVolMute.hidden = !muted;
  }

  private setSpeed(speed: number): void {
    this.video.playbackRate = speed;
    this.btnSpeed.textContent = `${speed}x`;
    this.speedPill.textContent = `${speed}x`;
    this.speedMenu.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', parseFloat(b.dataset.speed || '1') === speed);
    });
  }

  private async togglePiP(): Promise<void> {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (document.pictureInPictureEnabled) {
      await this.video.requestPictureInPicture();
    }
  }

  private toggleFullscreen(): void {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      this.wrapper.requestFullscreen();
    }
  }

  private renderPlaylist(): void {
    if (!this.playlistManager) return;
    this.playlistCount.textContent = `${this.playlistManager.count} items`;
    this.playlistBadge.textContent = String(this.playlistManager.count);
    this.playlistItemsContainer.innerHTML = '';

    this.playlistManager.items.forEach((item, index) => {
      const el = document.createElement('div');
      el.className = 'playlist-item';
      if (index === this.playlistManager?.currentIndex) el.classList.add('active');

      el.innerHTML = `
        <span class="item-index">${index + 1}</span>
        <div class="item-info">
          <div class="item-name" title="${item.name}">${item.name}</div>
          <div class="item-meta">${item.size ? formatBytes(item.size) : item.provider.toUpperCase()}</div>
        </div>
      `;

      el.addEventListener('click', () => {
        const selected = this.playlistManager?.setIndex(index);
        this.playItem(selected);
      });

      this.playlistItemsContainer.appendChild(el);
    });
  }

  private updatePlaylistUI(): void {
    const items = this.playlistItemsContainer.querySelectorAll('.playlist-item');
    const curIdx = this.playlistManager?.currentIndex ?? -1;
    items.forEach((el, idx) => {
      el.classList.toggle('active', idx === curIdx);
    });
    // Next/Previous buttons are for track navigation
    const count = this.playlistManager?.count || 0;
    this.btnPrev.disabled = false;
    this.btnNext.disabled = false;

    if (count <= 1) {
      this.btnPrev.title = 'Previous Video (Only 1 in playlist)';
      this.btnNext.title = 'Next Video (Only 1 in playlist)';
    } else {
      this.btnPrev.title = this.playlistManager?.hasPrev() ? 'Previous Video (Shift+P)' : 'Previous Video (Loop to last)';
      this.btnNext.title = this.playlistManager?.hasNext() ? 'Next Video (Shift+N)' : 'Next Video (Loop to first)';
    }
  }

  private resetControlsTimer(): void {
    this.wrapper.classList.add('show-controls');
    if (this.hideControlsTimer) clearTimeout(this.hideControlsTimer);
    this.hideControlsTimer = window.setTimeout(() => {
      if (!this.video.paused) {
        this.wrapper.classList.remove('show-controls');
      }
    }, 2800);
  }

  private showBuffering(show: boolean): void {
    this.centerIndicator.hidden = !show;
  }

  private showAlert(msg: string): void {
    this.alertText.textContent = msg;
    this.alertToast.hidden = false;
  }

  private showWarning(msg: string): void {
    if (this.warningText && this.warningBanner) {
      this.warningText.textContent = msg;
      this.warningBanner.hidden = false;
    }
  }

  private setupMediaSession(): void {
    this.playlistManager?.updateMediaSession(
      () => this.video.play(),
      () => this.video.pause(),
      () => this.playNext(),
      () => this.playPrevious(),
      (to) => { this.video.currentTime = to; }
    );
  }

  private toggleSubtitles(): void {
    if (!this.activeSubTrack) {
      this.showAlert('No subtitle track loaded. Drop an .srt, .vtt, or .ass file to attach subtitles.');
      return;
    }
    const track = this.video.textTracks[0];
    if (track) {
      const isShowing = track.mode === 'showing';
      track.mode = isShowing ? 'hidden' : 'showing';
      this.btnCc.classList.toggle('active', !isShowing);
    }
  }

  private async attachSubtitleFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const lower = file.name.toLowerCase();
      const fmt = lower.endsWith('.srt') ? 'srt' : (lower.endsWith('.ass') || lower.endsWith('.ssa')) ? 'ass' : 'vtt';
      const trackUrl = createSubtitleTrackUrl(text, fmt);

      if (this.activeSubTrack) {
        this.activeSubTrack.remove();
      }

      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = file.name;
      track.srclang = 'en';
      track.src = trackUrl;
      track.default = true;

      this.video.appendChild(track);
      this.activeSubTrack = track;
      this.video.textTracks[0].mode = 'showing';
      this.btnCc.classList.add('active');
      this.showAlert(`Loaded subtitles: ${file.name}`);
    } catch {
      this.showAlert('Failed to parse subtitle file.');
    }
  }

  private async loadCompanionSubtitle(subTrack: SubtitleTrackInfo): Promise<void> {
    try {
      const provider = PROVIDERS.find((p) => p.id === subTrack.provider);
      if (!provider) return;

      const subSource = await provider.open({
        id: subTrack.id,
        name: subTrack.name,
        size: 0,
        provider: subTrack.provider,
        ref: subTrack.ref,
      });

      const maxLen = subSource.size > 0 ? subSource.size - 1 : 2 * 1024 * 1024;
      const stream = await subSource.read(0, maxLen);
      const bytes = await readAll(stream);
      const text = new TextDecoder('utf-8').decode(bytes);

      const lower = subTrack.name.toLowerCase();
      const fmt = lower.endsWith('.srt') ? 'srt' : (lower.endsWith('.ass') || lower.endsWith('.ssa')) ? 'ass' : 'vtt';
      const trackUrl = createSubtitleTrackUrl(text, fmt);

      if (this.activeSubTrack) {
        this.activeSubTrack.remove();
        this.activeSubTrack = null;
      }

      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = subTrack.label || subTrack.name;
      track.srclang = subTrack.srclang || 'en';
      track.src = trackUrl;
      track.default = true;

      this.video.appendChild(track);
      this.activeSubTrack = track;
      if (this.video.textTracks && this.video.textTracks.length > 0) {
        this.video.textTracks[0].mode = 'showing';
      }
      this.btnCc.classList.add('active');
    } catch (e) {
      console.warn('Failed to auto-load companion subtitle:', e);
    }
  }

  private handleDroppedFiles(files: File[]): void {
    const subFiles = files.filter((f) => isSubtitleName(f.name));
    const mediaFiles = files.filter((f) => !isSubtitleName(f.name));

    if (mediaFiles.length > 0) {
      const playlist = createLocalPlaylist(files);
      this.playlistManager = new PlaylistManager(playlist);
      this.renderPlaylist();
      this.playItem(this.playlistManager.currentItem);
    } else if (subFiles.length > 0) {
      this.attachSubtitleFile(subFiles[0]);
    }
  }

  private startPositionSaver(): void {
    if (this.savePositionInterval) clearInterval(this.savePositionInterval);
    this.savePositionInterval = window.setInterval(() => {
      const item = this.playlistManager?.currentItem;
      if (item && !this.video.paused) {
        this.playlistManager?.savePosition(item, this.video.currentTime, this.video.duration);
      }
    }, 5000);
  }
}

const controller = new PlayerController();
controller.init();
