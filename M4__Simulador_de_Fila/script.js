const EVENT_TYPES = {
    CHEGADA: "CHEGADA",
    SAIDA: "SAIDA",
};

let lastResult = null;
let stateChart = null;

function readParams() {
    return {
        seed: Number.parseInt(document.getElementById("seed").value, 10),
        a: Number.parseInt(document.getElementById("multiplier").value, 10),
        c: Number.parseInt(document.getElementById("increment").value, 10),
        M: Number.parseInt(document.getElementById("modulus").value, 10),
        firstArrival: Number.parseFloat(document.getElementById("first-arrival").value),
        minArrival: Number.parseFloat(document.getElementById("min-arrival").value),
        maxArrival: Number.parseFloat(document.getElementById("max-arrival").value),
        minService: Number.parseFloat(document.getElementById("min-service").value),
        maxService: Number.parseFloat(document.getElementById("max-service").value),
        servers: Number.parseInt(document.getElementById("servers").value, 10),
        K: Number.parseInt(document.getElementById("capacity").value, 10),
        randomCount: Number.parseInt(document.getElementById("random-count").value, 10),
    };
}

function validateParams(p) {
    if (!Number.isFinite(p.seed) || !Number.isFinite(p.a) || !Number.isFinite(p.c) || !Number.isFinite(p.M)) {
        return "Parametros do LCG invalidos.";
    }
    if (p.M <= 1) return "M deve ser maior que 1.";
    if (p.seed < 0 || p.seed >= p.M) return "A semente deve obedecer 0 <= X0 < M.";
    if (p.a <= 0 || p.a >= p.M) return "O multiplicador deve obedecer 0 < a < M.";
    if (p.c < 0 || p.c >= p.M) return "O incremento deve obedecer 0 <= c < M.";

    if (p.firstArrival < 0) return "A primeira chegada deve ser >= 0.";
    if (p.minArrival > p.maxArrival) return "minArrival deve ser <= maxArrival.";
    if (p.minService > p.maxService) return "minService deve ser <= maxService.";
    if (p.minArrival < 0 || p.maxArrival < 0 || p.minService < 0 || p.maxService < 0) {
        return "Intervalos uniformes devem ser nao-negativos.";
    }

    if (p.servers < 1) return "c deve ser >= 1.";
    if (p.K < 1) return "K deve ser >= 1.";
    if (p.K < p.servers) return "K deve ser >= c.";
    if (p.randomCount < 1) return "Quantidade de aleatorios deve ser >= 1.";
    return "";
}

function nextRandom(rng) {
    if (rng.remaining <= 0) {
        return null;
    }
    rng.previous = (rng.a * rng.previous + rng.c) % rng.M;
    rng.remaining -= 1;
    rng.used += 1;
    return rng.previous / rng.M;
}

function uniform(min, max, rng) {
    const u = nextRandom(rng);
    if (u === null) {
        return null;
    }
    return min + (max - min) * u;
}

function enqueueEvent(queue, event) {
    let idx = queue.length;
    while (idx > 0 && queue[idx - 1].tempo > event.tempo) {
        idx -= 1;
    }
    queue.splice(idx, 0, event);
}

function nextEvent(queue) {
    return queue.shift();
}

function scheduleNextArrival(state, params) {
    const delta = uniform(params.minArrival, params.maxArrival, state.rng);
    if (delta === null) {
        return false;
    }

    enqueueEvent(state.events, {
        tempo: state.tempoAtual + delta,
        tipo: EVENT_TYPES.CHEGADA,
    });
    return true;
}

function scheduleDeparture(state, params) {
    const service = uniform(params.minService, params.maxService, state.rng);
    if (service === null) {
        return false;
    }

    enqueueEvent(state.events, {
        tempo: state.tempoAtual + service,
        tipo: EVENT_TYPES.SAIDA,
    });
    return true;
}

function processArrival(state, params) {
    if (state.N < params.K) {
        state.N += 1;

        if (state.emServico < params.servers) {
            state.emServico += 1;
            scheduleDeparture(state, params);
        }
    } else {
        state.perdas += 1;
    }

    scheduleNextArrival(state, params);
}

function processDeparture(state, params) {
    if (state.emServico <= 0 || state.N <= 0) {
        return;
    }

    state.emServico -= 1;
    state.N -= 1;

    const fila = state.N - state.emServico;
    if (fila > 0) {
        state.emServico += 1;
        scheduleDeparture(state, params);
    }
}

function runSimulation(params) {
    const state = {
        tempoAtual: 0,
        tempoAnterior: 0,
        N: 0,
        emServico: 0,
        perdas: 0,
        times: Array(params.K + 1).fill(0),
        events: [],
        rng: {
            a: params.a,
            c: params.c,
            M: params.M,
            previous: params.seed,
            remaining: params.randomCount,
            used: 0,
        },
    };

    enqueueEvent(state.events, {
        tempo: params.firstArrival,
        tipo: EVENT_TYPES.CHEGADA,
    });

    while (state.events.length > 0 && state.rng.remaining > 0) {
        const evento = nextEvent(state.events);
        state.tempoAtual = evento.tempo;

        const deltaT = state.tempoAtual - state.tempoAnterior;
        state.times[state.N] += deltaT;
        state.tempoAnterior = state.tempoAtual;

        if (evento.tipo === EVENT_TYPES.CHEGADA) {
            processArrival(state, params);
        } else {
            processDeparture(state, params);
        }
    }

    const tempoGlobal = state.tempoAtual;
    const prob = state.times.map((value) => (tempoGlobal > 0 ? value / tempoGlobal : 0));
    const Nmedio = tempoGlobal > 0
        ? state.times.reduce((acc, t, i) => acc + i * t, 0) / tempoGlobal
        : 0;

    return {
        tempoGlobal,
        times: state.times,
        prob,
        Nmedio,
        perdas: state.perdas,
        pFilaVazia: prob[0] ?? 0,
        randomUsed: state.rng.used,
        randomRemaining: state.rng.remaining,
        stopReason: state.rng.remaining <= 0 ? "Aleatorios esgotados" : "Fila de eventos vazia",
    };
}

function renderMetrics(result) {
    const container = document.getElementById("metrics");
    const items = [
        ["Tempo total", result.tempoGlobal.toFixed(6)],
        ["Perdas", String(result.perdas)],
        ["Populacao media (Nmedio)", result.Nmedio.toFixed(6)],
        ["Prob. fila vazia", result.pFilaVazia.toFixed(6)],
        ["Aleatorios usados", String(result.randomUsed)],
        ["Aleatorios restantes", String(result.randomRemaining)],
        ["Parada", result.stopReason],
    ];

    container.innerHTML = items.map(([label, value]) => (
        `<article class="metric-card"><h3>${label}</h3><p>${value}</p></article>`
    )).join("");
}

function renderStates(result) {
    const tbody = document.getElementById("states-table");
    tbody.innerHTML = result.times.map((tempo, i) => {
        return `<tr><td>${i}</td><td>${tempo.toFixed(6)}</td><td>${result.prob[i].toFixed(6)}</td></tr>`;
    }).join("");
}

function renderStateChart(result) {
    const canvas = document.getElementById("stateChart");
    if (!canvas) {
        return;
    }

    const labels = result.prob.map((_, i) => `Estado ${i}`);
    const values = result.prob;

    if (stateChart) {
        stateChart.destroy();
    }

    stateChart = new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label: "P(i)",
                    data: values,
                    backgroundColor: "#FF4FD8",
                    borderColor: "#FF4FD8",
                    borderWidth: 1,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    title: {
                        display: true,
                        text: "Estado i",
                    },
                },
                y: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: "Probabilidade",
                    },
                },
            },
        },
    });
}

function exportChartPng() {
    if (!stateChart && lastResult) {
        renderStateChart(lastResult);
    }
    if (!stateChart) {
        return;
    }

    const url = stateChart.toBase64Image("image/png", 1);
    const link = document.createElement("a");
    link.href = url;
    link.download = "probabilidade_estados.png";
    link.click();
}

function exportCsv(result) {
    const rows = ["estado,tempo,probabilidade"];
    for (let i = 0; i < result.times.length; i += 1) {
        rows.push(`${i},${result.times[i].toFixed(6)},${result.prob[i].toFixed(6)}`);
    }

    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "resultado_simulacao_fila.csv";
    link.click();
    URL.revokeObjectURL(url);
}

function executeSimulation() {
    const errorNode = document.getElementById("error");
    const params = readParams();
    const error = validateParams(params);

    if (error) {
        errorNode.textContent = error;
        return;
    }

    errorNode.textContent = "";
    lastResult = runSimulation(params);
    renderMetrics(lastResult);
    renderStates(lastResult);
    renderStateChart(lastResult);
}

function loadMinimumScenario(servers) {
    document.getElementById("first-arrival").value = "2.0";
    document.getElementById("min-arrival").value = "2.0";
    document.getElementById("max-arrival").value = "5.0";
    document.getElementById("min-service").value = "3.0";
    document.getElementById("max-service").value = "5.0";
    document.getElementById("servers").value = String(servers);
    document.getElementById("capacity").value = "5";
}

document.getElementById("run").addEventListener("click", executeSimulation);

document.getElementById("scenario-c1").addEventListener("click", () => {
    loadMinimumScenario(1);
    executeSimulation();
});

document.getElementById("scenario-c2").addEventListener("click", () => {
    loadMinimumScenario(2);
    executeSimulation();
});

document.getElementById("download-csv").addEventListener("click", () => {
    if (!lastResult) {
        executeSimulation();
    }
    if (lastResult) {
        exportCsv(lastResult);
    }
});

document.getElementById("download-chart").addEventListener("click", exportChartPng);

window.addEventListener("DOMContentLoaded", () => {
    executeSimulation();
});
