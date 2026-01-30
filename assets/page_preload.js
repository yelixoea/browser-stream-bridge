(function (global) {
  'use strict';

  var _isInitialized = false;
  var _volume = 1.0;
  var _isPaused = false;
  var _videoWidth = 0;
  var _videoHeight = 0;
  var _eventListeners = [];
  var _mutationObserver = null;
  var _statusInterval = null;

  var HOST_CONFIGS = {
    'tv.cctv.com': {
      beforeInit: function () {
        var resolutionValues = {
          "超清": 720,
          "高清": 540,
          "标清": 480,
          "流畅": 360
        };

        var resolution = new URLSearchParams(window.location.search).get('resolution');
        localStorage.setItem('cctv_live_resolution', resolutionValues[resolution] || 'auto');
      },

      init: function () {
        var errorMsgEl = document.getElementById('error_msg_player');
        if (errorMsgEl) {
          throw new Error(errorMsgEl.textContent);
        }
      },
    },

    'yangshipin.cn': {
      init: function () {
        var self = this;
        var resolution = new URLSearchParams(window.location.search).get('resolution');

        return self._waitForElement('.bei-list-inner, .bright-text')
          .then(function () {
            var spans = document.querySelectorAll('.bei-list-inner span');
            var resolutionItem = Array.from(spans).find(function (span) {
              return span.innerText && span.innerText.includes(resolution);
            });

            if (resolutionItem) {
              resolutionItem.click();
              return self._waitForVideoMetadata();
            }
          })
          .then(function () {
            var errorMsgEl = document.querySelector('.bright-text');
            if (errorMsgEl) {
              throw new Error(errorMsgEl.textContent);
            }
          });
      },
    },

    'live.snrtv.com': {
      init: function () {
        var channel = (new URLSearchParams(window.location.search)).get('channel');
        var lis = document.querySelectorAll('.btnStream > li');
        var channelItem = Array.from(lis)
          .find(function (li) {
            return li.innerText && li.innerText.includes(channel);
          });

        if (channelItem) {
          channelItem.click();
        }
      }
    },

    'live.jstv.com': {
      init: function () {
        var self = this;
        var channel = (new URLSearchParams(window.location.search)).get('channel');

        return self._waitForElement('#programMain')
          .then(function () {
            var slides = document.querySelector('#programMain').querySelectorAll('.swiper-slide');
            var channelItem = Array.from(slides).find(function (slide) {
              return slide.innerText && slide.innerText.includes(channel);
            });

            if (channelItem) {
              var imgBox = channelItem.querySelector('.imgBox');
              if (imgBox) imgBox.click();
            }
          });
      }
    },

    'www.nbs.cn': {
      init: function () {
        var channel = (new URLSearchParams(window.location.search)).get('channel');
        var items = document.querySelectorAll('.tv_list > .tv_c');
        var channelItem = Array.from(items).find(function (item) {
          return item.innerText && item.innerText.includes(channel);
        });

        if (channelItem) {
          channelItem.click();
        }
      }
    },

    'www.brtn.cn': {
      init: function () {
        var channel = (new URLSearchParams(window.location.search)).get('channel');
        var lis = document.querySelectorAll('.right_list li');
        var channelItem = Array.from(lis).find(function (li) {
          return li.innerText && li.innerText.includes(channel);
        });

        if (channelItem) {
          channelItem.click();
        }
      }
    },

    'web.guangdianyun.tv': {
      init: function () {
        return this._waitForVideoMetadata();
      }
    },

    'www.cditv.cn': {
      init: function () {
        setInterval(function () {
          var video = document.querySelector('video');
          if (video) {
            video.parentElement.style.transform = 'none';
          }
        }, 1000);
      }
    },
  };

  var WebviewVideoPlayer = {
    initialize: function () {
      if (_isInitialized) {
        _log('Video player already initialized, skipping duplicate call', 'warn');
        return Promise.resolve();
      }

      _log('Starting video player initialization...');

      var beforeInit = HOST_CONFIGS[location.host] && HOST_CONFIGS[location.host].beforeInit;
      if (beforeInit) {
        try {
          beforeInit();
        } catch (e) {
          _log('Pre-initialization failed: ' + e.message, 'error');
        }
      }

      var self = this;

      return this._waitForVideoElement()
        .then(function () {
          var init = HOST_CONFIGS[location.host] && HOST_CONFIGS[location.host].init;
          if (init) { return init.call(self); }
        })
        .then(function () {
          return self._waitForVideoElement();
        })
        .then(function () {
          window.__video_ready = true;
          self._startRecordMedia();
          self._startStatusMonitoring();
          _isInitialized = true;
          _log('Video player initialized successfully');
        })
        .catch(function (error) {
          _log('Initialization failed: ' + error.message, 'error');
          self._showErrorUI(error.message);
          throw error;
        });
    },

    destroy: function () {
      _log('Cleaning up resources...');

      _eventListeners.forEach(function (item) {
        item.element.removeEventListener(item.type, item.listener);
      });
      _eventListeners = [];

      if (_mutationObserver) {
        _mutationObserver.disconnect();
        _mutationObserver = null;
      }

      if (_statusInterval) {
        clearInterval(_statusInterval);
        _statusInterval = null;
      }

      _isInitialized = false;
    },

    play: function () {
      _isPaused = false;
      var video = this._getVideoElement();
      if (video) video.play();
    },

    pause: function () {
      _isPaused = true;
      var video = this._getVideoElement();
      if (video) video.pause();
    },

    stop: function () {
      this.pause();
    },

    setVolume: function (volume) {
      _volume = Math.max(0, Math.min(1, volume));
      var video = this._getVideoElement();
      if (video) video.volume = _volume;
    },

    getVolume: function () {
      var video = this._getVideoElement();
      return video ? video.volume : 1.0;
    },

    _getVideoElement: function () {
      return document.querySelector('video');
    },

    _waitForVideoElement: function (timeout) {
      timeout = timeout || 60000;
      var video = this._getVideoElement();
      if (video) return Promise.resolve(video);

      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          observer.disconnect();
          reject(new Error('等待video元素超时'));
        }, timeout);

        var observer = new MutationObserver(function () {
          var v = document.querySelector('video');
          if (v) {
            clearTimeout(timer);
            observer.disconnect();
            resolve(v);
          }
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true
        });
      });
    },

    _waitForVideoMetadata: function (timeout) {
      timeout = timeout || 60000;
      var video = this._getVideoElement();
      if (!video) return Promise.reject(new Error('video元素不存在'));
      if (video.videoWidth > 0) return Promise.resolve();

      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          cleanup();
          reject(new Error('等待video元数据超时'));
        }, timeout);

        var cleanup = function () {
          clearTimeout(timer);
          video.removeEventListener('loadedmetadata', onLoaded);
        };

        var onLoaded = function () {
          cleanup();
          resolve();
        };

        video.addEventListener('loadedmetadata', onLoaded);
      });
    },

    _waitForElement: function (selector, timeout) {
      timeout = timeout || 60000;
      var element = document.querySelector(selector);
      if (element) return Promise.resolve(element);

      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          observer.disconnect();
          reject(new Error('等待元素超时: ' + selector));
        }, timeout);

        var observer = new MutationObserver(function () {
          var el = document.querySelector(selector);
          if (el) {
            clearTimeout(timer);
            observer.disconnect();
            resolve(el);
          }
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true
        });
      });
    },

    _prepareDOMEnvironment: function () {
      var viewportMeta = document.querySelector('meta[name="viewport"]');
      if (!viewportMeta) {
        viewportMeta = document.createElement('meta');
        viewportMeta.name = 'viewport';
        document.head.appendChild(viewportMeta);
      }
      viewportMeta.content = 'width=device-width, initial-scale=1.0';

      document.body.style.margin = '0';
      document.body.style.overflow = 'hidden';

      const stylesheets = document.querySelectorAll('link[rel="stylesheet"], style')
      stylesheets.forEach(sheet => sheet.remove())
    },

    _enterFullscreen: function () {
      var video = this._getVideoElement();
      if (!video) return;

      video.style.position = 'fixed';
      video.style.top = '-1px';
      video.style.left = '-1px';
      video.style.right = '-1px';
      video.style.bottom = '-1px';
      video.style.width = 'calc(100vw + 2px)';
      video.style.height = 'calc(100vh + 2px)';
      video.style.zIndex = '9999';
      video.style.backgroundColor = 'black';
      video.style.objectFit = 'cover';
      video.style.boxSizing = 'border-box';
      video.style.pointerEvents = 'auto';
      video.style.margin = '0';
      video.style.padding = '0';
      video.style.border = 'none';

      _log('Entered fullscreen mode');
    },

    _attachEventListeners: function () {
      var video = this._getVideoElement();
      if (!video) return;

      var handlers = {
        play: function () {
          _isPaused = false;
          if (window.WebviewVideoPlayerInterface && window.WebviewVideoPlayerInterface.triggerPlaying) {
            window.WebviewVideoPlayerInterface.triggerPlaying();
          }
        },
        pause: function () {
          _isPaused = true;
          if (window.WebviewVideoPlayerInterface && window.WebviewVideoPlayerInterface.triggerPaused) {
            window.WebviewVideoPlayerInterface.triggerPaused();
          }
        },
        waiting: function () {
          if (window.WebviewVideoPlayerInterface && window.WebviewVideoPlayerInterface.triggerLoading) {
            window.WebviewVideoPlayerInterface.triggerLoading();
          }
        },
        ended: function () {
          if (window.WebviewVideoPlayerInterface && window.WebviewVideoPlayerInterface.triggerEnded) {
            window.WebviewVideoPlayerInterface.triggerEnded();
          }
        },
        error: function (event) {
          _log('Video error', 'error');
          if (window.WebviewVideoPlayerInterface && window.WebviewVideoPlayerInterface.triggerError) {
            window.WebviewVideoPlayerInterface.triggerError();
          }
        },
        loadedmetadata: function () {
          if (video.videoWidth && video.videoHeight) {
            _videoWidth = video.videoWidth;
            _videoHeight = video.videoHeight;
            if (window.WebviewVideoPlayerInterface && window.WebviewVideoPlayerInterface.changeResolution) {
              window.WebviewVideoPlayerInterface.changeResolution(_videoWidth, _videoHeight);
            }
          }
        },
        timeupdate: function () {
          if (window.WebviewVideoPlayerInterface && window.WebviewVideoPlayerInterface.changePosition) {
            window.WebviewVideoPlayerInterface.changePosition(Math.floor(video.currentTime));
          }
        }
      };

      Object.keys(handlers).forEach(function (event) {
        video.addEventListener(event, handlers[event]);
        _eventListeners.push({
          element: video,
          type: event,
          listener: handlers[event]
        });
      });

      _log('Event listeners have been attached');
    },

    _startStatusMonitoring: function () {
      var self = this;
      var video = this._getVideoElement();
      if (!video) return;

      var metadataHandler = function () {
        if (video.videoWidth && video.videoHeight) {
          self._updateResolution(video.videoWidth, video.videoHeight);
        }
      };
      video.addEventListener('loadedmetadata', metadataHandler);
      _eventListeners.push({
        element: video,
        type: 'loadedmetadata',
        listener: metadataHandler
      });

      var srcHandler = function () {
        if (video.videoWidth && video.videoHeight) {
          self._updateResolution(video.videoWidth, video.videoHeight);
        }
      };
      video.addEventListener('loadstart', srcHandler);
      _eventListeners.push({
        element: video,
        type: 'loadstart',
        listener: srcHandler
      });

      _mutationObserver = new MutationObserver(function () {
        if (video.videoWidth && video.videoHeight) {
          if (video.videoWidth !== _videoWidth || video.videoHeight !== _videoHeight) {
            _videoWidth = video.videoWidth;
            _videoHeight = video.videoHeight;
            if (window.WebviewVideoPlayerInterface && window.WebviewVideoPlayerInterface.changeResolution) {
              window.WebviewVideoPlayerInterface.changeResolution(_videoWidth, _videoHeight);
            }
          }
        }
      });

      _mutationObserver.observe(video, {
        attributes: true,
        attributeFilter: ['src', 'videoWidth', 'videoHeight']
      });

      _statusInterval = setInterval(function () {
        var v = self._getVideoElement();
        if (!v) return;

        if (v.volume !== _volume) {
          v.volume = _volume;
        }

        if (!_isPaused && v.paused && v.readyState >= 2) {
          v.play().catch(function (err) {
            _log('Autoplay failed: ' + err.message, 'warn');
          });
        }else if (_isPaused && !v.paused) {
          v.pause();
        }

        if (v.videoWidth !== _videoWidth || v.videoHeight !== _videoHeight) {
          self._updateResolution(v.videoWidth, v.videoHeight);
        }
      }, 1000);
    },

    _updateResolution: function (width, height) {
      if (width === _videoWidth && height === _videoHeight) return;

      _videoWidth = width;
      _videoHeight = height;

      if (window.WebviewVideoPlayerInterface && window.WebviewVideoPlayerInterface.changeResolution) {
        window.WebviewVideoPlayerInterface.changeResolution(_videoWidth, _videoHeight);
      }
      _log('Resolution updated: ' + _videoWidth + 'x' + _videoHeight);
    },

    _showErrorUI: function (message) {
      var errorDiv = document.getElementById('webview-video-error');
      if (!errorDiv) {
        errorDiv = document.createElement('div');
        errorDiv.id = 'webview-video-error';
        var cssProps = [
          'position: fixed',
          'top: 0',
          'left: 0',
          'width: 100%',
          'height: 100%',
          'z-index: 100000',
          'background-color: black',
          'color: white',
          'font-size: 3vw',
          'text-align: center',
          'display: flex',
          'justify-content: center',
          'align-items: center',
          'font-family: system-ui, sans-serif'
        ];
        errorDiv.style.cssText = cssProps.join(';');
        document.body.appendChild(errorDiv);
      }

      errorDiv.textContent = message;
    },

    _startRecordMedia: function () {
      var self = this;

      return this._waitForVideoMetadata().then(function () {
        var video = self._getVideoElement();

        var stream = video.captureStream();

        console.log(window.__VIDEO_BITRATE)
        var recorder = new MediaRecorder(stream, {
          mimeType: 'video/webm;codecs=h264,opus',
          videoBitsPerSecond: window.__VIDEO_BITRATE || 6000000,
          audioBitsPerSecond: 128000
        });

        recorder.ondataavailable = function (e) {
          if (!e.data || e.data.size === 0) return;

          window.__media_capture_ready = true;

          e.data.arrayBuffer().then(function (buf) {
            window.__pushMediaChunk(new Uint8Array(buf));
          });
        };

        recorder.start(100);
      });
    }
  };

  function _log(message, level) {
    level = level || 'info';
    if (window.WebviewVideoPlayerInterface && window.WebviewVideoPlayerInterface.logV) {
      window.WebviewVideoPlayerInterface.logV('[WebviewVideoPlayer] ' + message);
    }
    if (console && console[level]) {
      console[level](message);
    }
  }

  if (!global.WebviewVideoPlayer) {
    global.WebviewVideoPlayer = WebviewVideoPlayer;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(function () {
        global.WebviewVideoPlayer.initialize();
      }, 500);
    });
  } else {
    setTimeout(function () {
      global.WebviewVideoPlayer.initialize();
    }, 500);
  }
})(typeof window !== 'undefined' ? window : this);
