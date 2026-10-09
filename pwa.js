const installButton = document.getElementById('install-app-btn');
const installStatus = document.getElementById('install-app-status');
let pendingInstallPrompt = null;

function isAppInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function updateInstallVisibility() {
  if (installButton) installButton.hidden = isAppInstalled();
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  pendingInstallPrompt = event;
});

window.addEventListener('appinstalled', () => {
  pendingInstallPrompt = null;
  if (installStatus) installStatus.textContent = 'Panel Bot est installé sur ce téléphone.';
  updateInstallVisibility();
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch((error) => {
    console.error('Impossible de préparer l’installation du panel :', error);
    if (installStatus) {
      installStatus.textContent = 'Installation indisponible pour le moment. Réessaie après avoir rechargé la page.';
    }
  });
}

if (installButton) {
  installButton.addEventListener('click', async () => {
    if (isAppInstalled()) {
      updateInstallVisibility();
      return;
    }

    if (!pendingInstallPrompt) {
      const userAgent = navigator.userAgent;
      const isAppleMobile = /iPhone|iPad|iPod/.test(userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const isSamsungBrowser = /SamsungBrowser/i.test(userAgent);
      const isAndroid = /Android/i.test(userAgent);
      if (installStatus) {
        if (isAppleMobile) {
          installStatus.textContent = 'Dans Safari, touche Partager puis « Sur l’écran d’accueil ».';
        } else if (isSamsungBrowser) {
          installStatus.textContent = 'Dans Samsung Internet, ouvre le menu ☰ puis choisis « Ajouter une page à » et « Écran d’accueil ».';
        } else if (isAndroid) {
          installStatus.textContent = 'Dans le menu ⋮ de Chrome, touche « Installer l’application » ou « Ajouter à l’écran d’accueil ».';
        } else {
          installStatus.textContent = 'Ouvre le menu de ton navigateur et choisis « Installer » ou « Ajouter à l’écran d’accueil ».';
        }
      }
      return;
    }

    try {
      const promptEvent = pendingInstallPrompt;
      pendingInstallPrompt = null;
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (installStatus) {
        installStatus.textContent = choice.outcome === 'accepted'
          ? 'Panel Bot est en cours d’installation.'
          : 'Installation annulée. Tu peux la lancer depuis le menu de ton navigateur.';
      }
    } catch (error) {
      console.error('Échec de la demande d’installation :', error);
      if (installStatus) {
        installStatus.textContent = 'Installation impossible. Utilise le menu de ton navigateur pour ajouter le panel à l’écran d’accueil.';
      }
    }
  });
}

updateInstallVisibility();
