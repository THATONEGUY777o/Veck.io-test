// Variáveis Globais de Sincronização
let localPlayerId = null;
let currentRoomCode = null;
let syncInterval = null;

// -------------------------------------------------------------
// 1. Iniciar Partida Online
// -------------------------------------------------------------
function startOnlineMatch(playerName, roomCode) {
    currentRoomCode = roomCode;
    const colorBtn = document.querySelector('.color-btn.ring-2');
    const selectedColor = colorBtn ? colorBtn.getAttribute('data-color') : '#00f3ff';

    const badge = document.getElementById('activeRoomBadge');
    const roomCodeText = document.getElementById('activeRoomCode');
    if (badge && roomCodeText) {
        roomCodeText.innerText = roomCode;
        badge.classList.remove('hidden');
    }

    if (typeof audio !== 'undefined' && audio.init) {
        audio.init();
    }

    if (window.gameInstance) {
        // Limpa estado anterior
        window.gameInstance.players.clear();
        window.gameInstance.bullets = [];

        // Identificador único do jogador local
        localPlayerId = 'player_' + Math.random().toString(36).substring(2, 9);
        const sp = window.gameInstance.spawnPoints[Math.floor(Math.random() * window.gameInstance.spawnPoints.length)];
        
        window.gameInstance.localPlayer = new Player(localPlayerId, playerName, selectedColor, sp.x, sp.y, false);
        window.gameInstance.players.set(localPlayerId, window.gameInstance.localPlayer);

        // Sobrescreve o disparo para enviar as balas à rede
        const originalShoot = window.gameInstance.shootBullet.bind(window.gameInstance);
        window.gameInstance.shootBullet = function(player) {
            if (player.id === localPlayerId) {
                const bulletCountBefore = window.gameInstance.bullets.length;
                originalShoot(player);
                
                // Transmite as novas balas geradas para o Firebase
                if (window.gameInstance.bullets.length > bulletCountBefore) {
                    const newBullets = window.gameInstance.bullets.slice(bulletCountBefore);
                    newBullets.forEach(b => {
                        if (window.database && window.dbRef && window.dbPush) {
                            const bulletsRef = window.dbRef(window.database, `rooms/${roomCode}/bullets`);
                            window.dbPush(bulletsRef, {
                                ownerId: b.ownerId,
                                x: Math.round(b.x),
                                y: Math.round(b.y),
                                angle: b.angle,
                                weaponName: player.currentWeapon.name,
                                color: b.color,
                                timestamp: Date.now()
                            });
                        }
                    });
                }
            } else {
                originalShoot(player);
            }
        };

        window.gameInstance.startGameLoop();
        window.gameInstance.addChatMessage('SYS', `Conectado à sala: ${roomCode}`);

        setupNetworkSync(roomCode);
    }
}

// -------------------------------------------------------------
// 2. Sincronização em Tempo Real (Posições, Balas e Dano)
// -------------------------------------------------------------
function setupNetworkSync(roomCode) {
    if (!window.database || !window.dbRef || !window.dbOnValue) return;

    const playersRef = window.dbRef(window.database, `rooms/${roomCode}/players`);
    const bulletsRef = window.dbRef(window.database, `rooms/${roomCode}/bullets`);

    // A) Envia Posição e Status de Vida a cada 30ms (~30 FPS)
    if (syncInterval) clearInterval(syncInterval);
    syncInterval = setInterval(() => {
        if (window.gameInstance && window.gameInstance.localPlayer && localPlayerId) {
            const p = window.gameInstance.localPlayer;
            const myPlayerRef = window.dbRef(window.database, `rooms/${roomCode}/players/${localPlayerId}`);
            
            window.dbSet(myPlayerRef, {
                id: localPlayerId,
                name: p.name,
                color: p.color,
                x: Math.round(p.x),
                y: Math.round(p.y),
                vx: Math.round(p.vx || 0),
                vy: Math.round(p.vy || 0),
                angle: Number(p.angle.toFixed(2)),
                health: p.health,
                shield: p.shield,
                score: p.score,
                kills: p.kills,
                deaths: p.deaths,
                lastSeen: Date.now()
            });
        }
    }, 30);

    // B) Escuta Posições e Vida dos Outros Jogadores
    window.dbOnValue(playersRef, (snapshot) => {
        const playersData = snapshot.val();
        if (!playersData || !window.gameInstance) return;

        Object.keys(playersData).forEach((id) => {
            if (id === localPlayerId) return;

            const data = playersData[id];
            let remotePlayer = window.gameInstance.players.get(id);

            if (!remotePlayer) {
                remotePlayer = new Player(id, data.name, data.color, data.x, data.y, false);
                remotePlayer.isBot = false;
                window.gameInstance.players.set(id, remotePlayer);
                window.gameInstance.addChatMessage('SYS', `${data.name} entrou na arena!`);
            }

            // Atualização contínua das variáveis físicas e de vida
            remotePlayer.x = data.x;
            remotePlayer.y = data.y;
            remotePlayer.targetX = data.x;
            remotePlayer.targetY = data.y;
            remotePlayer.vx = data.vx || 0;
            remotePlayer.vy = data.vy || 0;
            remotePlayer.angle = data.angle;
            remotePlayer.health = data.health;
            remotePlayer.shield = data.shield;
            remotePlayer.score = data.score;
            remotePlayer.kills = data.kills || 0;
            remotePlayer.deaths = data.deaths || 0;
        });
    });

    // C) Escuta os Disparos dos Adversários na Nuvem
    window.dbOnValue(bulletsRef, (snapshot) => {
        const bulletsData = snapshot.val();
        if (!bulletsData || !window.gameInstance) return;

        Object.keys(bulletsData).forEach((bKey) => {
            const bData = bulletsData[bKey];
            
            // Desenha no ecran apenas tiros vindos de outros jogadores
            if (bData.ownerId !== localPlayerId && Date.now() - bData.timestamp < 1500) {
                const weapon = WEAPONS[bData.weaponName] || WEAPONS.BLASTER;
                const b = new Bullet(bKey, bData.ownerId, bData.x, bData.y, bData.angle, weapon, bData.color);
                
                // Evita duplicação da mesma bala
                if (!window.gameInstance.bullets.some(existing => existing.id === bKey)) {
                    window.gameInstance.bullets.push(b);
                    if (typeof audio !== 'undefined' && audio.playShoot) {
                        audio.playShoot(weapon.name.toLowerCase());
                    }
                }
            }
        });
    });
}

// -------------------------------------------------------------
// 3. Criar Sala
// -------------------------------------------------------------
function createRoom() {
    if (!window.database || !window.dbRef || !window.dbSet) {
        alert("A conectar ao Firebase, aguarde 2 segundos...");
        return;
    }

    const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
    const nicknameInput = document.getElementById('playerNameInput');
    const playerName = (nicknameInput && nicknameInput.value.trim() !== "") ? nicknameInput.value : 'CyberPilot';

    const roomRef = window.dbRef(window.database, 'rooms/' + roomCode);

    window.dbSet(roomRef, {
        host: playerName,
        status: 'active',
        createdAt: Date.now()
    }).then(() => {
        let btnMain = document.getElementById('btnOffline');
        if (btnMain) {
            btnMain.innerHTML = `<i class="fa-solid fa-rocket mr-2"></i> JOGAR ONLINE (SALA: ${roomCode})`;
            btnMain.style.background = "linear-gradient(to right, #10b981, #059669)";

            const newBtn = btnMain.cloneNode(true);
            btnMain.parentNode.replaceChild(newBtn, btnMain);

            newBtn.addEventListener('click', () => {
                startOnlineMatch(playerName, roomCode);
            });
        }
    }).catch((error) => {
        console.error("Erro ao criar sala:", error);
        alert("Erro ao registar a sala no servidor.");
    });
}

// -------------------------------------------------------------
// 4. Entrar na Sala
// -------------------------------------------------------------
function joinRoom() {
    if (!window.database || !window.dbRef || !window.dbGet) {
        alert("A conectar ao Firebase, aguarde 2 segundos...");
        return;
    }

    const roomInput = document.getElementById('roomCodeInput');
    const roomCode = roomInput ? roomInput.value.trim().toUpperCase() : "";

    if (roomCode.length < 5) {
        alert("Por favor, digita um código de sala válido!");
        return;
    }

    const nicknameInput = document.getElementById('playerNameInput');
    const playerName = (nicknameInput && nicknameInput.value.trim() !== "") ? nicknameInput.value : 'GuestPilot';

    const roomRef = window.dbRef(window.database, 'rooms/' + roomCode);

    window.dbGet(roomRef).then((snapshot) => {
        if (snapshot.exists()) {
            startOnlineMatch(playerName, roomCode);
        } else {
            alert("Sala não encontrada!");
        }
    }).catch((error) => {
        console.error("Erro ao procurar sala:", error);
        alert("Erro ao conectar à sala.");
    });
}

// -------------------------------------------------------------
// 5. Associação dos Eventos
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    const btnCreate = document.getElementById('btnCreateRoom');
    if (btnCreate) btnCreate.addEventListener('click', createRoom);

    const btnJoinRoom = document.getElementById('btnJoinRoom');
    if (btnJoinRoom) {
        btnJoinRoom.addEventListener('click', () => {
            const container = document.getElementById('roomInputContainer');
            if (container) container.classList.toggle('hidden');
        });
    }

    const btnConfirmJoin = document.getElementById('btnConfirmJoin');
    if (btnConfirmJoin) btnConfirmJoin.addEventListener('click', joinRoom);
});
