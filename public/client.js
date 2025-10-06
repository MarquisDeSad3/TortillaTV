// client.js — Manejo de conexión WebRTC con TURN TortillaTV

// --- Configuración STUN/TURN ---
const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: [
      'turn:45.76.60.11:3478?transport=udp',
      'turn:45.76.60.11:3478?transport=tcp',
      'turns:45.76.60.11:5349?transport=tcp' // cuando actives TLS
    ],
    username: 'tortilla',
    credential: 'Cl4uD1@2025'
  }
];

// Crear la conexión WebRTC
const pc = new RTCPeerConnection({ iceServers });

// Mostrar conexión en consola
console.log('TURN conectado con:', iceServers);

// --- Acceso a la cámara y micrófono ---
async function startLocalStream() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const videoElement = document.getElementById('localVideo');
    videoElement.srcObject = stream;
    stream.getTracks().forEach(track => pc.addTrack(track, stream));
    console.log('Cámara y micrófono activos.');
  } catch (error) {
    console.error('Error al acceder a la cámara/micrófono:', error);
  }
}

// --- Para pruebas ---
window.onload = () => {
  startLocalStream();
};
