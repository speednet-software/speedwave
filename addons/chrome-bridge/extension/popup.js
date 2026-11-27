const $ = (id) => document.getElementById(id);

async function render() {
  const { url = '', token = '' } = await chrome.storage.local.get(['url', 'token']);
  $('url').value = url;
  $('token').value = token;
  const status = await chrome.runtime.sendMessage({ type: 'status' });
  $('status').textContent = status.text;
  $('status').className = status.state;
}

$('connect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({
    type: 'connect',
    url: $('url').value.trim(),
    token: $('token').value.trim(),
  });
  setTimeout(render, 500);
});

$('disconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'disconnect' });
  setTimeout(render, 200);
});

render();
setInterval(render, 1000);
