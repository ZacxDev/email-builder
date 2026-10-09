'use strict';
// Toil-Killer S3 ship settings (homelab-infra #961). Credentials live
// ONLY in chrome.storage.local on this browser — never in code, a
// report, or a bundle. The key is write-only (PutObject on one
// bucket), so a leak costs that bucket's prefix, nothing else.
const KEY = 'tkS3V1';
const $ = (id) => document.getElementById(id);

async function load() {
  try {
    const got = await chrome.storage.local.get(KEY);
    const cfg = got?.[KEY];
    if (cfg && typeof cfg === 'object') {
      if (cfg.endpoint) $('endpoint').value = cfg.endpoint;
      if (cfg.bucket) $('bucket').value = cfg.bucket;
      if (cfg.accessKey) $('accessKey').value = cfg.accessKey;
      $('status').textContent = cfg.secretKey ? 'Secret saved on this browser.' : 'No secret saved yet.';
    }
  } catch { /* storage unavailable */ }
}

$('save').addEventListener('click', async () => {
  const cfg = {
    endpoint: $('endpoint').value.trim().replace(/\/+$/, ''),
    bucket: $('bucket').value.trim() || 'toil-killer-runs',
    accessKey: $('accessKey').value.trim(),
    secretKey: $('secretKey').value,
  };
  await chrome.storage.local.set({ [KEY]: cfg });
  $('status').textContent = cfg.secretKey
    ? 'Saved. Ship to homelab in the panel now uploads directly.'
    : 'Saved, but no secret entered — shipping will use Downloads.';
});

$('clear').addEventListener('click', async () => {
  const got = await chrome.storage.local.get(KEY);
  const cfg = got?.[KEY] ?? {};
  cfg.secretKey = '';
  await chrome.storage.local.set({ [KEY]: cfg });
  $('secretKey').value = '';
  $('status').textContent = 'Secret cleared from this browser.';
});

load();
