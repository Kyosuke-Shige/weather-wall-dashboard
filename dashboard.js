(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const refreshInterval = 15 * 60 * 1000;
  const hourSeconds = 3600;
  const storage = {
    mode: 'sora.weather-wall.nightMode',
    location: 'sora.weather-wall.location',
  };
  const weatherNames = new Map([
    [0, '快晴'], [1, '晴れ'], [2, '晴れ時々曇り'], [3, '曇り'],
    [45, '霧'], [48, '霧'], [51, '霧雨'], [53, '霧雨'], [55, '霧雨'],
    [56, '着氷性の霧雨'], [57, '着氷性の霧雨'], [61, '雨'], [63, '雨'], [65, '大雨'],
    [66, '着氷性の雨'], [67, '着氷性の雨'], [71, '雪'], [73, '雪'], [75, '大雪'],
    [77, '雪'], [80, 'にわか雨'], [81, 'にわか雨'], [82, '強いにわか雨'],
    [85, 'にわか雪'], [86, '強いにわか雪'], [95, '雷雨'], [96, '雷雨'], [99, '雷雨'],
  ]);
  const state = {
    nightMode: readSetting(storage.mode) !== 'off',
    previewUntil: 0,
    region: null,
    lastUpdate: null,
    locationSequence: 0,
    forecastRequest: null,
    searchRequest: null,
    wakeLock: null,
    wakeRequest: false,
    wakeAttempt: -Infinity,
    wasCovered: false,
  };

  function readSetting(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function writeSetting(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch { /* The current session still works. */ }
  }

  function savedRegion() {
    try {
      const region = JSON.parse(readSetting(storage.location));
      return validCoordinates(region) && typeof region.name === 'string' && region.name.trim()
        ? { ...region, manual: true }
        : null;
    } catch { return null; }
  }

  function validCoordinates(coords) {
    return coords && Number.isFinite(coords.latitude) && Math.abs(coords.latitude) <= 90 &&
      Number.isFinite(coords.longitude) && Math.abs(coords.longitude) <= 180;
  }

  const pad = (value) => String(value).padStart(2, '0');
  const clockTime = (date) => pad(date.getHours()) + ':' + pad(date.getMinutes());
  const monthDay = (date) => (date.getMonth() + 1) + '/' + date.getDate();
  const numberWithUnit = (value, unit) => Number.isFinite(value) ? Math.round(value) + unit : '—';
  const isProbability = (value) => Number.isFinite(value) && value >= 0 && value <= 100;
  const isDayValue = (value) => value === 0 || value === 1;

  function weatherType(code) {
    if (code <= 1) return 'clear';
    if ([2, 3, 45, 48].includes(code)) return 'cloudy';
    if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
    return 'rain';
  }

  function iconSvg(code, isDay) {
    if (!weatherNames.has(code)) return '';
    const type = weatherType(code);
    const rays = '<g stroke="#FFE7A0" stroke-width="3.6" stroke-linecap="round"><path d="M34 6v9M34 55v9M6 34h9M55 34h9M14.2 14.2l6.3 6.3M47.5 47.5l6.3 6.3M53.8 14.2l-6.3 6.3M20.5 47.5l-6.3 6.3"/></g>';
    const sun = rays + '<circle cx="34" cy="34" r="17" fill="#FFE3A3"/>';
    const moon = '<path d="M44 11A19 19 0 1057 44 21 21 0 0144 11Z" fill="#DCE7FF"/>';
    const cloud = '<path d="M30 70h49.5a17.5 17.5 0 001.1-35A27 27 0 0030.5 42 14.2 14.2 0 0030 70Z" fill="#FFFFFF"/><path d="M30 69h49" stroke="#D3E6F4" stroke-width="2.3" stroke-linecap="round" opacity=".9"/>';
    const rain = '<g stroke="#B8E9FF" stroke-linecap="round" stroke-width="5"><path d="M42 79l-6 11M62 79l-6 11M82 79l-6 11"/></g>';
    const snow = '<g stroke="#FFF" stroke-linecap="round" stroke-width="3"><path d="M42 80v12m-6-6h12M65 80v12m-6-6h12M88 80v12m-6-6h12"/></g>';
    const luminary = isDay ? sun : moon;
    let art = cloud;
    if (type === 'clear') art = '<g transform="translate(16 15) scale(1.15)">' + luminary + '</g>';
    if (code === 2) art = luminary + cloud;
    if (type === 'rain') art += rain;
    if (type === 'snow') art += snow;
    return '<svg viewBox="0 0 115 110" aria-hidden="true">' + art + '</svg>';
  }

  function setStatus(message, color = '#ffe297') {
    $('status-label').textContent = message;
    $('status-dot').style.background = color;
  }

  function showForecast(show) {
    for (const id of ['temp-chart', 'hour-list-wrap', 'hour-controls', 'week-grid']) {
      // SVG elements do not expose the HTMLElement.hidden property.
      $(id).toggleAttribute('hidden', !show);
    }
    $('hour-empty').hidden = show;
    $('week-empty').hidden = show;
  }

  function clearForecast() {
    state.lastUpdate = null;
    document.body.dataset.scene = 'unknown';
    $('weather-desc').textContent = '天気データ未取得';
    for (const id of ['current-temp', 'high-temp', 'low-temp', 'rain-value', 'humidity-value', 'feels-value']) {
      $(id).textContent = '—';
    }
    for (const id of ['hero-icon', 'temp-chart', 'hours-scroll', 'week-grid']) $(id).replaceChildren();
    $('updated-label').textContent = '最終更新 —';
    $('footer-note').textContent = '';
    showForecast(false);
  }

  function dateAtOffset(seconds, offset) {
    return new Date((seconds + offset) * 1000).toISOString().slice(0, 10);
  }

  function forecastForNow(data) {
    const { current, hourly, daily, timezone, utc_offset_seconds: offset } = data;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!current || !hourly || !daily || !Number.isInteger(offset) || Math.abs(offset) > 14 * hourSeconds ||
        typeof timezone !== 'string' || !Number.isInteger(current.time) ||
        Math.abs(nowSeconds - current.time) > hourSeconds ||
        !Number.isFinite(current.temperature_2m) || !Number.isFinite(current.apparent_temperature) ||
        !isProbability(current.relative_humidity_2m) || !weatherNames.has(current.weather_code) ||
        !isDayValue(current.is_day) || !Array.isArray(hourly.time) || !Array.isArray(daily.time)) {
      throw new Error('Invalid current forecast');
    }

    // The daily boundaries in this API response use this fixed offset.
    const today = dateAtOffset(nowSeconds, offset);
    const hourStart = hourly.time.findIndex((time) => time <= nowSeconds && nowSeconds < time + hourSeconds);
    const dayStart = daily.time.findIndex((time) => Number.isInteger(time) && dateAtOffset(time, offset) === today);
    if (hourStart < 0 || dayStart < 0) throw new Error('Missing forecast for today');

    const hourFields = ['time', 'temperature_2m', 'precipitation_probability', 'weather_code', 'is_day'];
    const dayFields = ['time', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_probability_max', 'weather_code'];
    const hours = records(hourly, hourFields, hourStart, 24);
    const days = records(daily, dayFields, dayStart, 7);
    const startTime = hours[0].time;
    if (!hours.every((hour, index) => Number.isInteger(hour.time) && hour.time === startTime + index * hourSeconds &&
        Number.isFinite(hour.temperature_2m)) ||
        !days.every((day, index) => Number.isInteger(day.time) && day.time === days[0].time + index * 24 * hourSeconds &&
        Number.isFinite(day.temperature_2m_max) && Number.isFinite(day.temperature_2m_min) &&
        day.temperature_2m_max >= day.temperature_2m_min)) {
      throw new Error('Incomplete forecast');
    }
    const hourFormat = new Intl.DateTimeFormat('ja-JP', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone });
    for (const hour of hours) hour.label = hourFormat.format(hour.time * 1000);
    hours[0] = { ...current, label: '今' };
    for (const day of days) {
      const date = new Date((day.time + offset) * 1000);
      day.label = (date.getUTCMonth() + 1) + '/' + date.getUTCDate();
      day.weekday = dayNames[date.getUTCDay()];
    }
    return { current, hours, days };
  }

  function records(data, fields, start, length) {
    if (!fields.every((field) => Array.isArray(data[field]) && data[field].length >= start + length)) {
      throw new Error('Missing forecast fields');
    }
    return Array.from({ length }, (_, index) =>
      Object.fromEntries(fields.map((field) => [field, data[field][start + index]])));
  }

  function chart(hours) {
    const temperatures = hours.map((hour) => hour.temperature_2m);
    const low = Math.floor(Math.min(...temperatures) - 2);
    const high = Math.ceil(Math.max(...temperatures) + 2);
    const left = 18;
    const right = 502;
    const top = 22;
    const baseline = 113;
    const x = (index) => left + (right - left) * index / (hours.length - 1);
    const y = (value) => top + (high - value) * (baseline - top) / (high - low);
    const path = temperatures.map((value, index) =>
      (index ? 'L' : 'M') + x(index).toFixed(1) + ',' + y(value).toFixed(1)).join(' ');
    const fill = path + ' L' + right + ',' + baseline + ' L' + left + ',' + baseline + ' Z';
    const bars = hours.map((hour, index) => {
      if (!isProbability(hour.precipitation_probability)) return '';
      const height = 14 * hour.precipitation_probability / 100;
      return `<rect x="${x(index) - 3}" y="${baseline - height}" width="6" height="${height}" rx="3" fill="#B0ECFF" opacity=".7"/>`;
    }).join('');
    const ticks = [0, 6, 12, 18, 23].map((index) =>
      `<text x="${x(index)}" y="137" fill="rgba(255,255,255,.86)" font-size="12" text-anchor="middle">${hours[index].label}</text>`).join('');
    const grid = [top, (top + baseline) / 2, baseline].map((line) =>
      `<path d="M${left} ${line}H${right}" stroke="rgba(255,255,255,.24)" stroke-dasharray="3 6"/>`).join('');
    const labels = [0, 12, 23].map((index) =>
      `<text x="${x(index)}" y="${y(temperatures[index]) - 9}" fill="white" font-size="12" font-weight="700" text-anchor="middle">${numberWithUnit(temperatures[index], '°')}</text>`).join('');
    const dots = [0, 6, 12, 18, 23].map((index) =>
      `<circle cx="${x(index)}" cy="${y(temperatures[index])}" r="3.3" fill="#FFF"/>`).join('');
    $('temp-chart').innerHTML = '<defs><linearGradient id="chart-shade" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#FFF" stop-opacity=".27"/><stop offset="1" stop-color="#FFF" stop-opacity="0"/></linearGradient></defs>' +
      grid + `<path d="${fill}" fill="url(#chart-shade)"/>` + bars +
      `<path d="${path}" fill="none" stroke="#FFFFFF" stroke-width="2.8" stroke-linejoin="round" stroke-linecap="round"/>` +
      dots + labels + ticks;
  }

  function probability(value) {
    return isProbability(value) ? numberWithUnit(value, '%') : '—';
  }

  function render({ current, hours, days }) {
    document.body.dataset.scene = current.is_day ? weatherType(current.weather_code) : 'night';
    $('weather-desc').textContent = weatherNames.get(current.weather_code);
    $('current-temp').textContent = numberWithUnit(current.temperature_2m, '');
    $('high-temp').textContent = numberWithUnit(days[0].temperature_2m_max, '°');
    $('low-temp').textContent = numberWithUnit(days[0].temperature_2m_min, '°');
    $('hero-icon').innerHTML = iconSvg(current.weather_code, current.is_day);
    $('rain-value').textContent = probability(current.precipitation_probability);
    $('humidity-value').textContent = probability(current.relative_humidity_2m);
    $('feels-value').textContent = numberWithUnit(current.apparent_temperature, '°');
    chart(hours);
    $('hours-scroll').innerHTML = hours.map((hour) =>
      `<div class="hour-item" title="${weatherNames.get(hour.weather_code) || '天気データなし'}"><div class="hour-time">${hour.label}</div>
        ${iconSvg(hour.weather_code, hour.is_day)}<div class="hour-temp">${numberWithUnit(hour.temperature_2m, '°')}</div>
        <div class="hour-pop">☂ ${probability(hour.precipitation_probability)}</div></div>`).join('');
    $('week-grid').innerHTML = days.map((day, index) =>
      `<div class="day${index === 0 ? ' today' : ''}" title="${weatherNames.get(day.weather_code) || '天気データなし'}">
        <div class="day-name">${index === 0 ? '今日' : day.weekday + '曜'} <span>${day.label}</span></div>${iconSvg(day.weather_code, true)}
        <div class="day-temps">${numberWithUnit(day.temperature_2m_max, '°')} <span>/ ${numberWithUnit(day.temperature_2m_min, '°')}</span></div>
        <div class="day-pop">☂ ${probability(day.precipitation_probability_max)}</div></div>`).join('');
    $('footer-note').textContent = '予報は地域の現地時刻';
    showForecast(true);
  }

  async function getJson(endpoint, params, controller) {
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(endpoint + '?' + new URLSearchParams(params), {
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  async function fetchWeather() {
    const region = state.region;
    if (!region || state.forecastRequest || document.hidden) return;
    const controller = new AbortController();
    state.forecastRequest = controller;
    const params = {
      latitude: region.latitude.toFixed(4),
      longitude: region.longitude.toFixed(4),
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,is_day,precipitation_probability',
      hourly: 'temperature_2m,precipitation_probability,weather_code,is_day',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      timezone: 'auto',
      timeformat: 'unixtime',
      forecast_days: '7',
    };
    if (!state.lastUpdate) setStatus('天気を取得しています…');
    try {
      const data = await getJson('https://api.open-meteo.com/v1/forecast', params, controller);
      if (state.region !== region) return;
      render(forecastForNow(data));
      const updated = new Date();
      state.lastUpdate = updated;
      setStatus(region.manual ? '指定した地域の天気' : '現在地の天気', '#9cf1bb');
      $('updated-label').textContent = '最終更新 ' + monthDay(updated) + ' ' + clockTime(updated);
    } catch {
      if (state.region !== region) return;
      setStatus(state.lastUpdate ? '更新できません · 前回取得した予報を表示中' :
        '天気を取得できません · 通信を確認してください');
    } finally {
      if (state.forecastRequest === controller) state.forecastRequest = null;
    }
  }

  function changeRegion(region) {
    state.forecastRequest?.abort();
    state.forecastRequest = null;
    state.region = region;
    clearForecast();
    $('location-label').textContent = region?.name || '現在地を取得';
    $('location-label').title = region?.name || '';
    fetchWeather();
  }

  function locate() {
    const sequence = ++state.locationSequence;
    writeSetting(storage.location, null);
    changeRegion(null);
    setStatus('現在地を取得しています…');
    const locationError = (error) => {
      if (sequence !== state.locationSequence) return;
      const cause = {
        1: '位置情報が許可されていません',
        3: '位置情報の取得がタイムアウトしました',
      }[error?.code] || '現在地を取得できません';
      setStatus(cause + ' · 右上から再試行または地域を指定');
      $('location-label').textContent = '地域を設定';
    };
    if (!navigator.geolocation || !window.isSecureContext) {
      locationError();
      return;
    }
    navigator.geolocation.getCurrentPosition((position) => {
      if (sequence !== state.locationSequence) return;
      if (!validCoordinates(position.coords)) {
        locationError();
        return;
      }
      changeRegion({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        name: '現在地',
        manual: false,
      });
    }, locationError, { enableHighAccuracy: false, timeout: 14000, maximumAge: 0 });
  }

  async function searchPlaces(event) {
    event.preventDefault();
    const name = $('place-query').value.trim();
    const status = $('place-status');
    const results = $('place-results');
    state.searchRequest?.abort();
    state.searchRequest = null;
    results.replaceChildren();
    if (name.length < 2) {
      status.textContent = '地域名を2文字以上入力してください。';
      return;
    }
    const controller = new AbortController();
    state.searchRequest = controller;
    status.textContent = '検索しています…';
    try {
      const data = await getJson('https://geocoding-api.open-meteo.com/v1/search',
        { name, count: '8', language: 'ja' }, controller);
      if (state.searchRequest !== controller || !$('location-dialog').open) return;
      const places = (data.results || []).filter((place) =>
        validCoordinates(place) && typeof place.name === 'string' && place.name.length);
      status.textContent = places.length ? '表示する地域を選んでください。' : '地域が見つかりません。別の名前で検索してください。';
      for (const place of places) {
        const label = [...new Set([place.name, place.admin2, place.admin1, place.country].filter(Boolean))].join(' · ');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', () => {
          const region = { latitude: place.latitude, longitude: place.longitude, name: label, manual: true };
          state.locationSequence++;
          writeSetting(storage.location, JSON.stringify(region));
          $('location-dialog').close();
          changeRegion(region);
        });
        results.append(button);
      }
    } catch {
      if (state.searchRequest === controller) status.textContent = '地域検索に失敗しました。通信を確認してください。';
    } finally {
      if (state.searchRequest === controller) state.searchRequest = null;
    }
  }

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 3800);
  }

  function shouldKeepAwake() {
    return !document.hidden && !$('sleep-cover').classList.contains('show');
  }

  async function syncWakeLock() {
    if (!navigator.wakeLock) return;
    if (!shouldKeepAwake()) {
      if (state.wakeLock) await state.wakeLock.release().catch(() => {});
      state.wakeAttempt = -Infinity;
      return;
    }
    if (state.wakeLock || state.wakeRequest || Date.now() - state.wakeAttempt < 60000) return;
    state.wakeAttempt = Date.now();
    state.wakeRequest = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (lock.released || !shouldKeepAwake()) {
        if (!lock.released) await lock.release();
        return;
      }
      state.wakeLock = lock;
      lock.addEventListener('release', () => {
        if (state.wakeLock === lock) state.wakeLock = null;
      }, { once: true });
    } catch { /* Android can deny a wake lock when power saving is active. */ }
    finally { state.wakeRequest = false; }
  }

  function clockTick() {
    const now = new Date();
    const time = clockTime(now);
    const date = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日 (' + dayNames[now.getDay()] + ')';
    if ($('clock').textContent !== time) $('clock').textContent = time;
    if ($('date').textContent !== date) $('date').textContent = date;
    const hour = now.getHours();
    const covered = state.nightMode && (hour < 7 || hour >= 9) && now.getTime() >= state.previewUntil;
    if (covered !== state.wasCovered) {
      if (covered && $('location-dialog').open) $('location-dialog').close();
      $('sleep-cover').classList.toggle('show', covered);
      $('sleep-cover').setAttribute('aria-hidden', String(!covered));
      document.documentElement.classList.toggle('covered', covered);
      if (!covered) fetchWeather();
      state.wasCovered = covered;
    }
    syncWakeLock();
  }

  function updateModeButton() {
    $('mode-btn').textContent = '自動消灯 ' + (state.nightMode ? 'ON' : 'OFF');
    $('mode-btn').setAttribute('aria-pressed', String(state.nightMode));
  }

  $('mode-btn').addEventListener('click', () => {
    state.nightMode = !state.nightMode;
    state.previewUntil = 0;
    writeSetting(storage.mode, state.nightMode ? 'on' : 'off');
    updateModeButton();
    clockTick();
  });
  $('exit-sleep').addEventListener('click', () => {
    state.previewUntil = Date.now() + 10 * 60 * 1000;
    clockTick();
  });
  $('locate-btn').addEventListener('click', () => $('location-dialog').showModal());
  $('retry-location').addEventListener('click', () => {
    $('location-dialog').close();
    locate();
  });
  $('place-search').addEventListener('submit', searchPlaces);
  $('location-dialog').addEventListener('close', () => {
    if (!$('location-dialog').open) {
      state.searchRequest?.abort();
      state.searchRequest = null;
      $('place-results').replaceChildren();
      $('place-status').textContent = '';
    }
  });
  $('hour-prev').addEventListener('click', () => $('hours-scroll').scrollBy({ left: -285 }));
  $('hour-next').addEventListener('click', () => $('hours-scroll').scrollBy({ left: 285 }));
  $('fullscreen-btn').hidden = !document.fullscreenEnabled || matchMedia('(display-mode: fullscreen)').matches;
  $('fullscreen-btn').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { showToast('このブラウザでは全画面にできません。'); }
  });
  document.addEventListener('fullscreenchange', () => {
    $('fullscreen-btn').textContent = document.fullscreenElement ? '全画面を解除' : '全画面';
  });

  function resume() {
    state.wakeAttempt = -Infinity;
    clockTick();
    fetchWeather();
  }
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('pageshow', (event) => { if (event.persisted) resume(); });
  window.addEventListener('online', fetchWeather);
  updateModeButton();
  clockTick();
  setInterval(clockTick, 1000);
  setInterval(fetchWeather, refreshInterval);
  const manualRegion = savedRegion();
  if (manualRegion) changeRegion(manualRegion);
  else locate();
})();
