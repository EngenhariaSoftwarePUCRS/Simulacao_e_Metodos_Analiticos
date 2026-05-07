const EVENT_TYPES = {
    ARRIVAL: "ARRIVAL",
    DEPARTURE: "DEPARTURE",
};

const EXTERNAL_QUEUE_ID = -1;
const PROBABILITY_EPSILON = 1e-9;
const MAX_RANDOM_NUMBERS = 100000;

const AUTO_REGENERATE_DELAY = 250;
const DEFAULT_TABLE_LIMIT = 50;
const EXPANDED_TABLE_LIMIT = 1000;
const MAX_CELL_CHARS = 80;

let lastResult = null;
let lcgScatterChart = null;
let regenerateTimeoutId = null;
let statesTableLimit = DEFAULT_TABLE_LIMIT;
let scheduleTableLimit = DEFAULT_TABLE_LIMIT;
let queueStateCharts = new Map();
let queueStateTableLimits = new Map();

// Fallback YAML to use when ../model.yml cannot be fetched (e.g., GitHub Pages)
const DEFAULT_MODEL_YAML = `!PARAMETERS
arrivals:
  Q1: 2.0

queues:
  Q1:
    servers: 1
    capacity: -1
    minArrival: 2.0
    maxArrival: 4.0
    minService: 1.0
    maxService: 2.0
  Q2:
    servers: 2
    capacity: 5
    minService: 4.0
    maxService: 6.0
  Q3:
    servers: 2
    capacity: 10
    minService: 5.0
    maxService: 15.0

network:
- source: Q1
  target: Q2
  probability: 0.8
- source: Q1
  target: Q3
  probability: 0.2

- source: Q2
  target: Q3
  probability: 0.5
- source: Q2
  target: Q1
  probability: 0.3
- source: Q2
  target: -1
  probability: 0.2

- source: Q3
  target: Q2
  probability: 0.7
- source: Q3
  target: -1
  probability: 0.3

# Optional: use LCG seeds to generate pseudo-random numbers for reproducible runs
rndnumbersPerSeed: 100000
seeds:
   - 42
`;

function formatNumber(value) {
    return Number(value).toFixed(4);
}

function formatQueueId(queueId) {
    return queueId === EXTERNAL_QUEUE_ID ? "Externo" : String(queueId);
}

function formatEventType(type) {
    return type === EVENT_TYPES.ARRIVAL ? "Chegada" : "Saida";
}

function formatEventLabel(event) {
    if (event.type === EVENT_TYPES.ARRIVAL) {
        return `${formatEventType(event.type)} (${formatQueueId(event.sourceQueue)} -> ${formatQueueId(event.targetQueue)})`;
    }

    return `${formatEventType(event.type)} (${formatQueueId(event.sourceQueue)} -> roteamento)`;
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function truncateForCell(text, maxChars = MAX_CELL_CHARS) {
    const fullText = String(text);
    if (fullText.length <= maxChars) {
        return `<span title="${escapeHtml(fullText)}">${escapeHtml(fullText)}</span>`;
    }

    const shortText = `${fullText.slice(0, maxChars - 1)}...`;
    return `<span title="${escapeHtml(fullText)}">${escapeHtml(shortText)}</span>`;
}

function setLimitToggleLabel(buttonId, currentLimit) {
    const button = document.getElementById(buttonId);
    if (!button) {
        return;
    }

    button.textContent = currentLimit === DEFAULT_TABLE_LIMIT
        ? "Mostrar 1000 primeiros"
        : "Mostrar 50 primeiros";
}

function setQueueLimitToggleLabel(buttonId, currentLimit) {
    const button = document.getElementById(buttonId);
    if (!button) return;

    button.textContent = currentLimit === DEFAULT_TABLE_LIMIT
        ? "Mostrar 1000 primeiros"
        : "Mostrar 50 primeiros";
}

function createQueue({ id, servers, capacity, minArrival = null, maxArrival = null, minService, maxService, routes }) {
    return {
        id: String(id),
        servers,
        capacity,
        minArrival,
        maxArrival,
        minService,
        maxService,
        routes,
        currentSize: 0,
        lossCount: 0,
        stateTime: new Map([[0, 0]]),
    };
}

function enqueueEvent(queue, event) {
    let idx = queue.length;
    while (idx > 0 && queue[idx - 1].time > event.time) {
        idx -= 1;
    }
    queue.splice(idx, 0, event);
}

function nextEvent(queue) {
    return queue.shift();
}

function queueWaitingCount(queue) {
    return Math.max(0, queue.currentSize - queue.servers);
}

function isQueueFull(queue) {
    return queue.capacity !== -1 && queue.currentSize >= queue.capacity;
}

function addStateTime(queue, deltaTime) {
    if (deltaTime <= 0) {
        return;
    }

    const current = queue.stateTime.get(queue.currentSize) ?? 0;
    queue.stateTime.set(queue.currentSize, current + deltaTime);
}

function accumulateTimes(sim, nextEventTime) {
    const deltaTime = nextEventTime - sim.previousTime;
    if (deltaTime < 0) {
        return;
    }

    sim.queueOrder.forEach((queueId) => {
        const queue = sim.queues.get(queueId);
        addStateTime(queue, deltaTime);
    });

    sim.previousTime = nextEventTime;
}

function pushSchedulerRow(sim, row) {
    sim.schedulerTotal += 1;
    sim.schedulerCounter += 1;

    if (sim.schedulerRows.length >= EXPANDED_TABLE_LIMIT) {
        return;
    }

    sim.schedulerRows.push({
        event: `(${sim.schedulerCounter}) ${row.event}`,
        tempo: row.tempo,
        sorteio: row.sorteio,
    });
}

function pushProcessedRow(sim, event) {
    sim.processedTotal += 1;
    sim.processedCounter += 1;

    if (sim.processedRows.length >= EXPANDED_TABLE_LIMIT) {
        return;
    }

    const queueSnapshots = sim.queueOrder.map((queueId) => {
        const queue = sim.queues.get(queueId);
        return {
            id: queueId,
            customers: queue.currentSize,
            waiting: queueWaitingCount(queue),
        };
    });

    sim.processedRows.push({
        event: `${sim.processedCounter} - ${formatEventLabel(event)}`,
        globalTime: sim.currentTime,
        queueSnapshots,
    });
    // no debug capture in production mode
}

function createListRandomSource(values, maxUsage) {
    return {
        type: "list",
        values,
        index: 0,
        used: 0,
        maxUsage,
    };
}

function createLcgRandomSource({ seed, a, c, M, maxUsage }) {
    return {
        type: "lcg",
        previous: seed,
        a,
        c,
        M,
        used: 0,
        maxUsage,
    };
}

function nextRandom(rng) {
    if (rng.used >= rng.maxUsage) {
        return null;
    }

    let value = null;

    if (rng.type === "list") {
        if (rng.index >= rng.values.length) {
            return null;
        }

        value = rng.values[rng.index];
        rng.index += 1;
    } else {
        rng.previous = (rng.a * rng.previous + rng.c) % rng.M;
        value = rng.previous / rng.M;
    }

    rng.used += 1;

    return value;
}

function uniform(min, max, rng) {
    const u = nextRandom(rng);
    if (u === null) {
        return null;
    }

    return {
        u,
        value: min + (max - min) * u,
    };
}

function chooseRoute(routes, rng) {
    if (routes.length === 1 && Math.abs(routes[0].probability - 1) <= PROBABILITY_EPSILON) {
        return {
            destination: routes[0].destination,
            deterministic: true,
            u: null,
        };
    }

    const u = nextRandom(rng);
    if (u === null) {
        return null;
    }

    let cumulative = 0;
    for (const route of routes) {
        cumulative += route.probability;
        if (u < cumulative + PROBABILITY_EPSILON) {
            return {
                destination: route.destination,
                deterministic: false,
                u,
            };
        }
    }

    return {
        destination: routes[routes.length - 1].destination,
        deterministic: false,
        u,
    };
}

function scheduleEvent(sim, event, schedulerInfo) {
    enqueueEvent(sim.events, event);
    pushSchedulerRow(sim, schedulerInfo);
}

function scheduleInitialArrivals(sim) {
    sim.initialArrivals.forEach((time, queueId) => {
        const event = {
            type: EVENT_TYPES.ARRIVAL,
            time,
            sourceQueue: EXTERNAL_QUEUE_ID,
            targetQueue: queueId,
        };

        scheduleEvent(sim, event, {
            event: `${formatEventLabel(event)} inicial`,
            tempo: `0.0000 + t0(${formatNumber(time)}) = ${formatNumber(time)}`,
            sorteio: `t0 = ${formatNumber(time)}`,
        });
    });
}

function scheduleQueueDeparture(sim, queue) {
    const draw = uniform(queue.minService, queue.maxService, sim.rng);
    if (draw === null) {
        return false;
    }

    const scheduledTime = sim.currentTime + draw.value;
    const event = {
        type: EVENT_TYPES.DEPARTURE,
        time: scheduledTime,
        sourceQueue: queue.id,
        targetQueue: EXTERNAL_QUEUE_ID,
    };

    scheduleEvent(sim, event, {
        event: formatEventLabel(event),
        tempo: `${formatNumber(sim.currentTime)} + ${formatNumber(draw.value)} = ${formatNumber(scheduledTime)}`,
        sorteio: `u=${formatNumber(draw.u)}; U(${formatNumber(queue.minService)}, ${formatNumber(queue.maxService)}) = ${formatNumber(draw.value)}`,
    });

    return true;
}

function scheduleNextExternalArrival(sim, queue) {
    if (queue.minArrival === null || queue.maxArrival === null) {
        return true;
    }

    const draw = uniform(queue.minArrival, queue.maxArrival, sim.rng);
    if (draw === null) {
        return false;
    }

    const scheduledTime = sim.currentTime + draw.value;
    const event = {
        type: EVENT_TYPES.ARRIVAL,
        time: scheduledTime,
        sourceQueue: EXTERNAL_QUEUE_ID,
        targetQueue: queue.id,
    };

    scheduleEvent(sim, event, {
        event: formatEventLabel(event),
        tempo: `${formatNumber(sim.currentTime)} + ${formatNumber(draw.value)} = ${formatNumber(scheduledTime)}`,
        sorteio: `u=${formatNumber(draw.u)}; U(${formatNumber(queue.minArrival)}, ${formatNumber(queue.maxArrival)}) = ${formatNumber(draw.value)}`,
    });

    return true;
}

function scheduleRoutedArrival(sim, sourceQueue, destinationQueue, routeChoice) {
    const event = {
        type: EVENT_TYPES.ARRIVAL,
        time: sim.currentTime,
        sourceQueue: sourceQueue.id,
        targetQueue: destinationQueue,
    };

    const routingInfo = routeChoice.deterministic
        ? "Roteamento deterministico"
        : `u=${formatNumber(routeChoice.u)}; destino=${formatQueueId(destinationQueue)}`;

    scheduleEvent(sim, event, {
        event: formatEventLabel(event),
        tempo: `${formatNumber(sim.currentTime)} + 0.0000 = ${formatNumber(event.time)}`,
        sorteio: routingInfo,
    });
}

function stopByRandomExhaustion(sim) {
    sim.shouldStop = true;
    if (!sim.stopReason) {
        sim.stopReason = "Aleatorios esgotados";
    }
}

function handleArrival(sim, event) {
    const queue = sim.queues.get(event.targetQueue);
    if (!queue) {
        return;
    }

    if (isQueueFull(queue)) {
        queue.lossCount += 1;
    } else {
        queue.currentSize += 1;

        if (queue.currentSize <= queue.servers) {
            const scheduledDeparture = scheduleQueueDeparture(sim, queue);
            if (!scheduledDeparture) {
                stopByRandomExhaustion(sim);
                return;
            }
        }
    }

    if (event.sourceQueue === EXTERNAL_QUEUE_ID && sim.initialArrivals.has(queue.id)) {
        const scheduledExternalArrival = scheduleNextExternalArrival(sim, queue);
        if (!scheduledExternalArrival) {
            stopByRandomExhaustion(sim);
        }
    }
}

function handleDeparture(sim, event) {
    const queue = sim.queues.get(event.sourceQueue);
    if (!queue || queue.currentSize <= 0) {
        return;
    }

    queue.currentSize -= 1;

    if (queue.currentSize >= queue.servers) {
        const scheduledDeparture = scheduleQueueDeparture(sim, queue);
        if (!scheduledDeparture) {
            stopByRandomExhaustion(sim);
            return;
        }
    }

    const routeChoice = chooseRoute(queue.routes, sim.rng);
    if (routeChoice === null) {
        stopByRandomExhaustion(sim);
        return;
    }

    if (routeChoice.destination !== EXTERNAL_QUEUE_ID) {
        scheduleRoutedArrival(sim, queue, routeChoice.destination, routeChoice);
    }
}

function buildStateDomain(queue) {
    if (queue.capacity !== -1) {
        return Array.from({ length: queue.capacity + 1 }, (_, i) => i);
    }

    const observedStates = [...queue.stateTime.keys()];
    const maxState = observedStates.length === 0 ? 0 : Math.max(...observedStates);
    return Array.from({ length: maxState + 1 }, (_, i) => i);
}

function computeQueueMetrics(queue, globalTime) {
    const states = buildStateDomain(queue);
    const times = states.map((state) => queue.stateTime.get(state) ?? 0);
    const prob = times.map((time) => (globalTime > 0 ? time / globalTime : 0));
    const nMedio = globalTime > 0
        ? states.reduce((acc, state, index) => acc + state * times[index], 0) / globalTime
        : 0;

    return {
        id: queue.id,
        states,
        times,
        prob,
        nMedio,
        pVazia: prob[0] ?? 0,
        loss: queue.lossCount,
    };
}

function runSimulation(modelBlueprint, rngSource) {
    const queues = new Map();
    modelBlueprint.queueOrder.forEach((queueId) => {
        const blueprint = modelBlueprint.queueBlueprints.get(queueId);
        queues.set(queueId, createQueue(blueprint));
    });

    const sim = {
        currentTime: 0,
        previousTime: 0,
        shouldStop: false,
        stopReason: "",
        events: [],
        queueOrder: modelBlueprint.queueOrder,
        queues,
        initialArrivals: new Map(modelBlueprint.initialArrivals),
        rng: rngSource,
        processedRows: [],
        processedTotal: 0,
        processedCounter: 0,
        schedulerRows: [],
        schedulerTotal: 0,
        schedulerCounter: 0,
    };

    scheduleInitialArrivals(sim);

    while (sim.events.length > 0 && !sim.shouldStop && sim.rng.used < sim.rng.maxUsage) {
        const event = nextEvent(sim.events);
        accumulateTimes(sim, event.time);
        sim.currentTime = event.time;

        if (event.type === EVENT_TYPES.ARRIVAL) {
            handleArrival(sim, event);
        } else {
            handleDeparture(sim, event);
        }

        pushProcessedRow(sim, event);
    }

    const queueMetrics = {};
    sim.queueOrder.forEach((queueId) => {
        queueMetrics[queueId] = computeQueueMetrics(sim.queues.get(queueId), sim.currentTime);
    });

    let stopReason = sim.stopReason;
    if (!stopReason) {
        if (sim.rng.used >= sim.rng.maxUsage) {
            stopReason = `Limite de ${sim.rng.maxUsage} aleatorios atingido`;
        } else if (sim.events.length === 0) {
            stopReason = "Fila de eventos vazia";
        } else {
            stopReason = "Simulacao interrompida";
        }
    }

    return {
        globalTime: sim.currentTime,
        randomUsed: sim.rng.used,
        randomRemaining: Math.max(0, sim.rng.maxUsage - sim.rng.used),
        stopReason,
        queueOrder: sim.queueOrder,
        queues: queueMetrics,
        processedRows: sim.processedRows,
        processedTotal: sim.processedTotal,
        schedulerRows: sim.schedulerRows,
        schedulerTotal: sim.schedulerTotal,
    };
}

function readParams() {
    return {
        seed: Number.parseInt(document.getElementById("seed")?.value ?? "", 10),
        a: Number.parseInt(document.getElementById("multiplier")?.value ?? "", 10),
        c: Number.parseInt(document.getElementById("increment")?.value ?? "", 10),
        M: Number.parseInt(document.getElementById("modulus")?.value ?? "", 10),
        randomCount: Number.parseInt(document.getElementById("count")?.value ?? "", 10),

        firstArrival: Number.parseFloat(document.getElementById("first-arrival")?.value ?? ""),

        f1MinArrival: Number.parseFloat(document.getElementById("f1-min-arrival")?.value ?? ""),
        f1MaxArrival: Number.parseFloat(document.getElementById("f1-max-arrival")?.value ?? ""),
        f1MinService: Number.parseFloat(document.getElementById("f1-min-service")?.value ?? ""),
        f1MaxService: Number.parseFloat(document.getElementById("f1-max-service")?.value ?? ""),
        f1Servers: Number.parseInt(document.getElementById("f1-servers")?.value ?? "", 10),
        f1Capacity: Number.parseInt(document.getElementById("f1-capacity")?.value ?? "", 10),

        f2MinService: Number.parseFloat(document.getElementById("f2-min-service")?.value ?? ""),
        f2MaxService: Number.parseFloat(document.getElementById("f2-max-service")?.value ?? ""),
        f2Servers: Number.parseInt(document.getElementById("f2-servers")?.value ?? "", 10),
        f2Capacity: Number.parseInt(document.getElementById("f2-capacity")?.value ?? "", 10),
    };
}

function validateLcgParams(params) {
    if (!Number.isFinite(params.seed) || !Number.isFinite(params.a) || !Number.isFinite(params.c) || !Number.isFinite(params.M)) {
        return "Parametros do LCG invalidos.";
    }
    if (params.M <= 1) return "M deve ser maior que 1.";
    if (params.seed < 0 || params.seed >= params.M) return "A semente deve obedecer 0 <= X0 < M.";
    if (params.a <= 0 || params.a >= params.M) return "O multiplicador deve obedecer 0 < a < M.";
    if (params.c < 0 || params.c >= params.M) return "O incremento deve obedecer 0 <= c < M.";
    if (!Number.isFinite(params.randomCount) || params.randomCount < 1) return "Quantidade de aleatorios deve ser >= 1.";

    return "";
}

function validateLegacyQueueParams(params) {
    if (!Number.isFinite(params.firstArrival) || params.firstArrival < 0) {
        return "A primeira chegada deve ser >= 0.";
    }

    if (!Number.isFinite(params.f1MinArrival) || !Number.isFinite(params.f1MaxArrival)) {
        return "Fila 1: minArrival/maxArrival invalidos.";
    }
    if (!Number.isFinite(params.f1MinService) || !Number.isFinite(params.f1MaxService)) {
        return "Fila 1: minService/maxService invalidos.";
    }
    if (params.f1MinArrival > params.f1MaxArrival) return "Fila 1: minArrival deve ser <= maxArrival.";
    if (params.f1MinService > params.f1MaxService) return "Fila 1: minService deve ser <= maxService.";
    if (params.f1Servers < 1) return "Fila 1: numero de servidores deve ser >= 1.";
    if (params.f1Capacity < 1) return "Fila 1: capacidade deve ser >= 1.";
    if (params.f1Capacity < params.f1Servers) return "Fila 1: capacidade deve ser >= numero de servidores.";
    if (params.f1MinArrival < 0 || params.f1MaxArrival < 0 || params.f1MinService < 0 || params.f1MaxService < 0) {
        return "Fila 1: os intervalos devem ser nao-negativos.";
    }

    if (!Number.isFinite(params.f2MinService) || !Number.isFinite(params.f2MaxService)) {
        return "Fila 2: minService/maxService invalidos.";
    }
    if (params.f2MinService > params.f2MaxService) return "Fila 2: minService deve ser <= maxService.";
    if (params.f2Servers < 1) return "Fila 2: numero de servidores deve ser >= 1.";
    if (params.f2Capacity < 1) return "Fila 2: capacidade deve ser >= 1.";
    if (params.f2Capacity < params.f2Servers) return "Fila 2: capacidade deve ser >= numero de servidores.";
    if (params.f2MinService < 0 || params.f2MaxService < 0) {
        return "Fila 2: os intervalos devem ser nao-negativos.";
    }

    return "";
}

function buildLegacyModel(params) {
    return {
        arrivals: {
            Q1: params.firstArrival,
        },
        queues: {
            Q1: {
                servers: params.f1Servers,
                capacity: params.f1Capacity,
                minArrival: params.f1MinArrival,
                maxArrival: params.f1MaxArrival,
                minService: params.f1MinService,
                maxService: params.f1MaxService,
            },
            Q2: {
                servers: params.f2Servers,
                capacity: params.f2Capacity,
                minService: params.f2MinService,
                maxService: params.f2MaxService,
            },
        },
        network: [
            {
                source: "Q1",
                target: "Q2",
                probability: 1.0,
            },
            {
                source: "Q2",
                target: EXTERNAL_QUEUE_ID,
                probability: 1.0,
            },
        ],
    };
}

function normalizeQueueId(rawQueueId) {
    if (rawQueueId === EXTERNAL_QUEUE_ID || String(rawQueueId).trim() === "-1") {
        return EXTERNAL_QUEUE_ID;
    }

    return String(rawQueueId).trim();
}

function parseYamlModel(yamlText) {
    const cleanedYaml = yamlText.replace(/^\s*!PARAMETERS\s*\r?\n?/m, "");
    if (!window.jsyaml) {
        return {
            error: "Biblioteca YAML nao carregada (js-yaml).",
            model: null,
        };
    }

    try {
        const parsed = window.jsyaml.load(cleanedYaml);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {
                error: "YAML invalido: estrutura raiz deve ser um objeto.",
                model: null,
            };
        }

        return {
            error: "",
            model: parsed,
        };
    } catch (error) {
        return {
            error: `Erro ao ler YAML: ${error.message}`,
            model: null,
        };
    }
}

function normalizeModel(rawModel) {
    const rawQueues = rawModel?.queues;
    if (!rawQueues || typeof rawQueues !== "object" || Array.isArray(rawQueues)) {
        throw new Error("Campo queues deve ser um mapa de filas.");
    }

    const queueOrder = Object.keys(rawQueues);
    if (queueOrder.length === 0) {
        throw new Error("Pelo menos uma fila deve ser declarada em queues.");
    }

    const queueBlueprints = new Map();
    queueOrder.forEach((queueId) => {
        const queueConfig = rawQueues[queueId] ?? {};

        const servers = Number(queueConfig.servers);
        const rawCapacity = queueConfig.capacity;
        const capacity = rawCapacity === undefined ? -1 : Number(rawCapacity);
        const minService = Number(queueConfig.minService);
        const maxService = Number(queueConfig.maxService);

        if (!Number.isInteger(servers) || servers < 1) {
            throw new Error(`Fila ${queueId}: servers deve ser inteiro >= 1.`);
        }

        if (!Number.isFinite(capacity) || (!Number.isInteger(capacity)) || capacity === 0 || capacity < -1) {
            throw new Error(`Fila ${queueId}: capacity deve ser -1 ou inteiro >= 1.`);
        }

        if (capacity !== -1 && capacity < servers) {
            throw new Error(`Fila ${queueId}: capacity deve ser >= servers.`);
        }

        if (!Number.isFinite(minService) || !Number.isFinite(maxService) || minService < 0 || maxService < 0 || minService > maxService) {
            throw new Error(`Fila ${queueId}: minService/maxService invalidos.`);
        }

        const hasMinArrival = queueConfig.minArrival !== undefined;
        const hasMaxArrival = queueConfig.maxArrival !== undefined;
        if (hasMinArrival !== hasMaxArrival) {
            throw new Error(`Fila ${queueId}: minArrival e maxArrival devem ser definidos juntos.`);
        }

        let minArrival = null;
        let maxArrival = null;
        if (hasMinArrival) {
            minArrival = Number(queueConfig.minArrival);
            maxArrival = Number(queueConfig.maxArrival);

            if (!Number.isFinite(minArrival) || !Number.isFinite(maxArrival) || minArrival < 0 || maxArrival < 0 || minArrival > maxArrival) {
                throw new Error(`Fila ${queueId}: minArrival/maxArrival invalidos.`);
            }
        }

        queueBlueprints.set(queueId, {
            id: queueId,
            servers,
            capacity,
            minArrival,
            maxArrival,
            minService,
            maxService,
            routes: [],
        });
    });

    const initialArrivals = new Map();
    const arrivals = rawModel.arrivals ?? {};
    if (typeof arrivals !== "object" || Array.isArray(arrivals)) {
        throw new Error("Campo arrivals deve ser um mapa de tempos iniciais por fila.");
    }

    Object.entries(arrivals).forEach(([queueId, firstArrival]) => {
        if (!queueBlueprints.has(queueId)) {
            throw new Error(`Arrivals: fila ${queueId} nao existe em queues.`);
        }

        const time = Number(firstArrival);
        if (!Number.isFinite(time) || time < 0) {
            throw new Error(`Arrivals: tempo inicial de ${queueId} deve ser >= 0.`);
        }

        initialArrivals.set(queueId, time);
    });

    // If no arrivals were declared, default the first queue to initial arrival time 2.0
    if (initialArrivals.size === 0 && queueOrder.length > 0) {
        initialArrivals.set(queueOrder[0], 2.0);
    }

    queueOrder.forEach((queueId) => {
        if (initialArrivals.has(queueId)) {
            const queueConfig = queueBlueprints.get(queueId);
            if (queueConfig.minArrival === null || queueConfig.maxArrival === null) {
                throw new Error(`Fila ${queueId}: chegadas externas exigem minArrival/maxArrival.`);
            }
        }
    });

    const network = rawModel.network ?? [];
    if (!Array.isArray(network)) {
        throw new Error("Campo network deve ser uma lista.");
    }

    network.forEach((route, routeIndex) => {
        const source = normalizeQueueId(route?.source);
        const destination = normalizeQueueId(route?.target);
        const probability = Number(route?.probability);

        if (source === EXTERNAL_QUEUE_ID) {
            throw new Error(`Network[${routeIndex}]: source nao pode ser externo.`);
        }

        if (!queueBlueprints.has(source)) {
            throw new Error(`Network[${routeIndex}]: source ${source} nao existe.`);
        }

        if (destination !== EXTERNAL_QUEUE_ID && !queueBlueprints.has(destination)) {
            throw new Error(`Network[${routeIndex}]: target ${destination} nao existe.`);
        }

        if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
            throw new Error(`Network[${routeIndex}]: probability invalida.`);
        }

        queueBlueprints.get(source).routes.push({
            destination,
            probability,
        });
    });

    queueOrder.forEach((queueId) => {
        const queueConfig = queueBlueprints.get(queueId);

        if (queueConfig.routes.length === 0) {
            queueConfig.routes.push({
                destination: EXTERNAL_QUEUE_ID,
                probability: 1,
            });
        }

        const probabilitySum = queueConfig.routes.reduce((acc, route) => acc + route.probability, 0);
        if (Math.abs(probabilitySum - 1) > PROBABILITY_EPSILON) {
            throw new Error(`Fila ${queueId}: soma das probabilidades de roteamento deve ser 1.`);
        }
    });

    return {
        queueOrder,
        queueBlueprints,
        initialArrivals,
    };
}

function createRngFromSeeds(rawModel, lcgParams) {
    const perSeed = Number(rawModel.rndnumbersPerSeed);
    if (!Number.isInteger(perSeed) || perSeed < 1) {
        throw new Error("rndnumbersPerSeed deve ser inteiro >= 1.");
    }

    const seeds = rawModel.seeds;
    if (!Array.isArray(seeds) || seeds.length === 0) {
        throw new Error("seeds deve ser uma lista nao vazia.");
    }

    const values = [];
    for (const seedValue of seeds) {
        const seed = Number(seedValue);
        if (!Number.isInteger(seed) || seed < 0 || seed >= lcgParams.M) {
            throw new Error(`Seed invalida: ${seedValue}. Deve obedecer 0 <= X0 < M.`);
        }

        let previous = seed;
        for (let i = 0; i < perSeed; i += 1) {
            previous = (lcgParams.a * previous + lcgParams.c) % lcgParams.M;
            values.push(previous / lcgParams.M);

            if (values.length >= MAX_RANDOM_NUMBERS) {
                break;
            }
        }

        if (values.length >= MAX_RANDOM_NUMBERS) {
            break;
        }
    }

    return createListRandomSource(values, MAX_RANDOM_NUMBERS);
}

function createRngFromYaml(rawModel, params) {
    const hasSeeds = Array.isArray(rawModel.seeds) && rawModel.seeds.length > 0;
    if (hasSeeds) {
        const lcgValidation = validateLcgParams(params);
        if (lcgValidation) {
            throw new Error(`Para usar seeds no YAML: ${lcgValidation}`);
        }

        return createRngFromSeeds(rawModel, {
            a: params.a,
            c: params.c,
            M: params.M,
        });
    }

    if (Array.isArray(rawModel.rndnumbers) && rawModel.rndnumbers.length > 0) {
        const values = rawModel.rndnumbers.map((value, index) => {
            const numericValue = Number(value);
            if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue >= 1) {
                throw new Error(`rndnumbers[${index}] deve estar em [0, 1).`);
            }
            return numericValue;
        });

        return createListRandomSource(values, MAX_RANDOM_NUMBERS);
    }

    const lcgValidation = validateLcgParams(params);
    if (lcgValidation) {
        throw new Error(`YAML sem rndnumbers/seeds exige LCG valido: ${lcgValidation}`);
    }

    return createLcgRandomSource({
        seed: params.seed,
        a: params.a,
        c: params.c,
        M: params.M,
        maxUsage: MAX_RANDOM_NUMBERS,
    });
}

function createLegacyRng(params) {
    return createLcgRandomSource({
        seed: params.seed,
        a: params.a,
        c: params.c,
        M: params.M,
        maxUsage: Math.min(MAX_RANDOM_NUMBERS, params.randomCount),
    });
}

function renderMetricCards(containerId, items) {
    const container = document.getElementById(containerId);
    if (!container) {
        return;
    }

    container.innerHTML = items.map(([label, value]) => (
        `<article class="metric-card"><h3>${label}</h3><p>${value}</p></article>`
    )).join("");
}

function renderMetrics(result, modeLabel) {
    renderMetricCards("global-metrics", [
        ["Tempo total", `${formatNumber(result.globalTime)} u.t.`],
        ["Aleatorios usados", `${result.randomUsed} amostras`],
        ["Aleatorios restantes", `${result.randomRemaining} amostras`],
        ["Filas na rede", `${result.queueOrder.length}`],
        ["Modo", modeLabel],
        ["Parada", result.stopReason],
    ]);
}

function renderQueueMetrics(result) {
    const container = document.getElementById("queues-metrics");
    if (!container) {
        return;
    }

    container.innerHTML = result.queueOrder.map((queueId) => {
        const queueResult = result.queues[queueId];
        return `
            <section class="queue-metrics-group">
                <h3>Fila ${escapeHtml(queueId)}</h3>
                <div class="metrics">
                    <article class="metric-card">
                        <h3>Perdas</h3>
                        <p>${queueResult.loss} clientes</p>
                    </article>
                    <article class="metric-card">
                        <h3>Populacao media (Nmedio)</h3>
                        <p>${formatNumber(queueResult.nMedio)} clientes</p>
                    </article>
                    <article class="metric-card">
                        <h3>Prob. fila vazia</h3>
                        <p>${formatNumber(queueResult.pVazia * 100)}%</p>
                    </article>
                </div>
            </section>
        `;
    }).join("");
}

function renderStates(result) {
    const head = document.getElementById("states-head");
    const tbody = document.getElementById("states-table");

    if (!head || !tbody) {
        return;
    }

    const dynamicColumns = result.queueOrder
        .map((queueId) => `<th>${escapeHtml(queueId)} clientes</th><th>${escapeHtml(queueId)} fila</th>`)
        .join("");

    head.innerHTML = `
        <tr>
            <th>Evento</th>
            <th>Tempo global</th>
            ${dynamicColumns}
        </tr>
    `;

    const visibleRows = result.processedRows.slice(0, statesTableLimit);
    const hiddenRowsCount = Math.max(0, result.processedTotal - visibleRows.length);

    let html = visibleRows.map((row) => {
        const queueCells = row.queueSnapshots
            .map((snapshot) => `<td>${snapshot.customers}</td><td>${snapshot.waiting}</td>`)
            .join("");

        return `
            <tr>
                <td>${escapeHtml(row.event)}</td>
                <td>${formatNumber(row.globalTime)}</td>
                ${queueCells}
            </tr>
        `;
    }).join("");

    if (hiddenRowsCount > 0) {
        const colSpan = 2 + (result.queueOrder.length * 2);
        html += `<tr><td colspan="${colSpan}">+ ${hiddenRowsCount} eventos ocultos (use o botao para expandir)</td></tr>`;
    }

    tbody.innerHTML = html;
}

function renderScheduler(result) {
    const tbody = document.getElementById("schedule-table");
    if (!tbody) {
        return;
    }

    const visibleRows = result.schedulerRows.slice(0, scheduleTableLimit);
    const hiddenRowsCount = Math.max(0, result.schedulerTotal - visibleRows.length);

    let html = visibleRows.map((row) => {
        return `<tr><td>${escapeHtml(row.event)}</td><td>${truncateForCell(row.tempo)}</td><td>${truncateForCell(row.sorteio)}</td></tr>`;
    }).join("");

    if (hiddenRowsCount > 0) {
        html += `<tr><td colspan="3">+ ${hiddenRowsCount} escalonamentos ocultos (use o botao para expandir)</td></tr>`;
    }

    tbody.innerHTML = html;
}

function createStateChart(canvasId, queueResult, label) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) {
        return null;
    }

    return new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: {
            labels: queueResult.states.map((state) => `Estado ${state}`),
            datasets: [
                {
                    label,
                    data: queueResult.prob,
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

function exportChartPng(chart, filename) {
    if (!chart) {
        return;
    }

    const url = chart.toBase64Image("image/png", 1);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
}

function clearQueueCharts() {
    queueStateCharts.forEach((chart) => chart.destroy());
    queueStateCharts = new Map();
}

function renderQueueStateSections(result) {
    const container = document.getElementById("queue-state-sections");
    if (!container) {
        return;
    }

    clearQueueCharts();
    container.innerHTML = "";

    // Note: overall CSV download is available via the 'Baixar CSV' button in the
    // execution controls; per-queue CSV/PNG controls remain in each panel.

    result.queueOrder.forEach((queueId, index) => {
        const queueResult = result.queues[queueId];
        const tableBodyId = `state-probability-table-${index}`;
        const chartId = `state-chart-${index}`;
        const downloadButtonId = `download-chart-${index}`;
        const toggleLimitButtonId = `toggle-queue-limit-${index}`;
        const downloadQueueCsvId = `download-queue-csv-${index}`;

        const panel = document.createElement("section");
        panel.className = "panel";
        panel.innerHTML = `
            <h2>Tabela de probabilidade por estado - Fila ${escapeHtml(queueId)}</h2>
            <div class="metrics" style="margin-bottom:0.6rem;">
                <article class="metric-card"><h3>Perdas</h3><p>${queueResult.loss} clientes</p></article>
                <article class="metric-card"><h3>População média (Nmedio)</h3><p>${formatNumber(queueResult.nMedio)} clientes</p></article>
                <article class="metric-card"><h3>Prob. fila vazia</h3><p>${formatNumber(queueResult.pVazia * 100)}%</p></article>
            </div>
            <table>
                <thead>
                    <tr>
                        <th>Estado (i)</th>
                        <th>Tempo acumulado</th>
                        <th>Probabilidade</th>
                    </tr>
                </thead>
                <tbody id="${tableBodyId}"></tbody>
            </table>
            <div class="chart-panel">
                <div class="chart-header">
                    <h2>Grafico de probabilidade por estado - Fila ${escapeHtml(queueId)}</h2>
                    <div>
                        <button id="${toggleLimitButtonId}" type="button">Mostrar 1000 primeiros</button>
                        <button id="${downloadQueueCsvId}" type="button">Baixar CSV</button>
                        <button id="${downloadButtonId}" type="button">Baixar PNG</button>
                    </div>
                </div>
                <canvas id="${chartId}"></canvas>
            </div>
        `;

        container.appendChild(panel);

        const tbody = document.getElementById(tableBodyId);
        if (tbody) {
            const currentLimit = queueStateTableLimits.get(queueId) ?? DEFAULT_TABLE_LIMIT;
            const visibleStates = queueResult.states.slice(0, currentLimit);
            tbody.innerHTML = visibleStates.map((state, stateIndex) => {
                return `<tr><td>${state}</td><td>${formatNumber(queueResult.times[stateIndex])}</td><td>${formatNumber(queueResult.prob[stateIndex])}</td></tr>`;
            }).join("");

            const hidden = Math.max(0, queueResult.states.length - visibleStates.length);
            if (hidden > 0) {
                tbody.insertAdjacentHTML("beforeend", `<tr><td colspan="3">+ ${hidden} estados ocultos (use o botao para expandir)</td></tr>`);
            }
        }

        const chart = createStateChart(chartId, queueResult, `P(i) ${queueId}`);
        if (chart) {
            queueStateCharts.set(queueId, chart);
        }

        const downloadButton = document.getElementById(downloadButtonId);
        if (downloadButton) {
            downloadButton.addEventListener("click", () => {
                exportChartPng(queueStateCharts.get(queueId), `probabilidade_estados_${queueId}.png`);
            });
        }

        const toggleLimitButton = document.getElementById(toggleLimitButtonId);
        if (toggleLimitButton) {
            // initialize label
            const initialLimit = queueStateTableLimits.get(queueId) ?? DEFAULT_TABLE_LIMIT;
            setQueueLimitToggleLabel(toggleLimitButtonId, initialLimit);
            toggleLimitButton.addEventListener("click", () => {
                const current = queueStateTableLimits.get(queueId) ?? DEFAULT_TABLE_LIMIT;
                const next = current === DEFAULT_TABLE_LIMIT ? EXPANDED_TABLE_LIMIT : DEFAULT_TABLE_LIMIT;
                queueStateTableLimits.set(queueId, next);
                setQueueLimitToggleLabel(toggleLimitButtonId, next);
                renderQueueStateSections(result);
            });
        }

        const downloadQueueCsvButton = document.getElementById(downloadQueueCsvId);
        if (downloadQueueCsvButton) {
            downloadQueueCsvButton.addEventListener("click", () => {
                const rows = ["fila,estado,tempo,probabilidade"];
                queueResult.states.forEach((state, index) => {
                    rows.push(`${queueId},${state},${formatNumber(queueResult.times[index])},${formatNumber(queueResult.prob[index])}`);
                });
                const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = `probabilidade_estados_${queueId}.csv`;
                link.click();
                URL.revokeObjectURL(url);
            });
        }
    });
}

function generateYamlFromBuilder() {
    const model = {
        queues: {
            Q1: {
                servers: Number(document.getElementById("f1-servers")?.value ?? 1),
                capacity: Number(document.getElementById("f1-capacity")?.value ?? -1),
                minArrival: Number(document.getElementById("f1-min-arrival")?.value ?? 0),
                maxArrival: Number(document.getElementById("f1-max-arrival")?.value ?? 0),
                minService: Number(document.getElementById("f1-min-service")?.value ?? 0),
                maxService: Number(document.getElementById("f1-max-service")?.value ?? 0),
            },
            Q2: {
                servers: Number(document.getElementById("f2-servers")?.value ?? 1),
                capacity: Number(document.getElementById("f2-capacity")?.value ?? -1),
                minService: Number(document.getElementById("f2-min-service")?.value ?? 0),
                maxService: Number(document.getElementById("f2-max-service")?.value ?? 0),
            },
        },
        arrivals: {
            Q1: Number(document.getElementById("first-arrival")?.value ?? 0),
        },
        network: [
            { source: "Q1", target: "Q2", probability: 1.0 },
            { source: "Q2", target: EXTERNAL_QUEUE_ID, probability: 1.0 },
        ],
    };

    let yamlText = "";
    if (window.jsyaml && window.jsyaml.dump) {
        yamlText = window.jsyaml.dump(model, { noRefs: true });
    } else {
        // fallback simple string
        yamlText = `queues:\n  Q1:\n    servers: ${model.queues.Q1.servers}\n    capacity: ${model.queues.Q1.capacity}\n    minArrival: ${model.queues.Q1.minArrival}\n    maxArrival: ${model.queues.Q1.maxArrival}\n    minService: ${model.queues.Q1.minService}\n    maxService: ${model.queues.Q1.maxService}\n  Q2:\n    servers: ${model.queues.Q2.servers}\n    capacity: ${model.queues.Q2.capacity}\n    minService: ${model.queues.Q2.minService}\n    maxService: ${model.queues.Q2.maxService}\narrivals:\n  Q1: ${model.arrivals.Q1}\nnetwork:\n  - source: Q1\n    target: Q2\n    probability: 1.0\n  - source: Q2\n    target: -1\n    probability: 1.0\n`;
    }

    const yamlNode = document.getElementById("yaml-config");
    if (yamlNode) {
        yamlNode.value = yamlText;
    }
}

function exportCsv(result) {
    const rows = ["fila,estado,tempo,probabilidade"];

    result.queueOrder.forEach((queueId) => {
        const queueResult = result.queues[queueId];
        queueResult.states.forEach((state, index) => {
            rows.push(`${queueId},${state},${formatNumber(queueResult.times[index])},${formatNumber(queueResult.prob[index])}`);
        });
    });

    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "resultado_simulacao_rede_filas.csv";
    link.click();
    URL.revokeObjectURL(url);
}

function generateLcgScatterPoints(seed, a, c, M, count) {
    const sampleCount = Math.max(2, Math.min(count, 5000));
    const values = [];
    let previous = seed;

    for (let i = 0; i < sampleCount; i += 1) {
        previous = (a * previous + c) % M;
        values.push(previous / M);
    }

    const points = [];
    for (let i = 0; i < values.length - 1; i += 1) {
        points.push({ x: values[i], y: values[i + 1] });
    }
    return points;
}

function renderLcgDistributionChart(params) {
    const canvas = document.getElementById("lcgScatterPlot");
    if (!canvas) {
        return;
    }

    const points = generateLcgScatterPoints(params.seed, params.a, params.c, params.M, params.randomCount);

    if (lcgScatterChart) {
        lcgScatterChart.destroy();
    }

    lcgScatterChart = new Chart(canvas.getContext("2d"), {
        type: "scatter",
        data: {
            datasets: [
                {
                    label: "U_i x U_i+1",
                    data: points,
                    pointRadius: 2,
                    backgroundColor: "#FF4FD8",
                    borderColor: "#FF4FD8",
                    showLine: false,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    min: 0,
                    max: 1,
                    title: {
                        display: true,
                        text: "U_i",
                    },
                },
                y: {
                    min: 0,
                    max: 1,
                    title: {
                        display: true,
                        text: "U_i+1",
                    },
                },
            },
        },
    });
}

function setupLcgAccordion() {
    const toggle = document.getElementById("lcg-accordion-toggle");
    const content = document.getElementById("lcg-distribution-content");
    if (!toggle || !content) {
        return;
    }

    toggle.addEventListener("click", () => {
        const isOpen = toggle.getAttribute("aria-expanded") === "true";
        if (isOpen) {
            toggle.setAttribute("aria-expanded", "false");
            toggle.textContent = "Mostrar grafico de distribuicao do LCG";
            content.hidden = true;
        } else {
            const params = readParams();
            const lcgValidation = validateLcgParams(params);
            if (lcgValidation) {
                document.getElementById("error").textContent = lcgValidation;
                return;
            }

            toggle.setAttribute("aria-expanded", "true");
            toggle.textContent = "Ocultar grafico de distribuicao do LCG";
            content.hidden = false;
            renderLcgDistributionChart(params);
        }
    });
}

function getYamlText() {
    return document.getElementById("yaml-config")?.value ?? "";
}

async function loadRepositoryModelYaml() {
    const errorNode = document.getElementById("error");
    try {
        const response = await fetch("../model.yml", { cache: "no-store" });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const text = await response.text();
        const yamlNode = document.getElementById("yaml-config");
        if (yamlNode) {
            yamlNode.value = text;
        }

        if (yamlNode) {
            // simply populate the YAML textarea from repository and run simulation
            yamlNode.value = text;
        }

        errorNode.textContent = "model.yml carregado com sucesso.";
        executeSimulation();
    } catch (error) {
        // Fallback: populate YAML textarea with embedded default model so GH-Pages
        // deployments that cannot serve ../model.yml still work.
        const yamlNode = document.getElementById("yaml-config");
        if (yamlNode) {
            yamlNode.value = DEFAULT_MODEL_YAML;
            errorNode.textContent = `Nao foi possivel carregar ../model.yml automaticamente: ${error.message}. Conteudo padrao carregado.`;
            executeSimulation();
        } else {
            errorNode.textContent = `Nao foi possivel carregar ../model.yml automaticamente: ${error.message}`;
        }
    }
}

function resolveSimulationSetup(params, useYaml) {
    if (useYaml) {
        const yamlText = getYamlText().trim();
        if (!yamlText) {
            return {
                error: "Modo YAML ativo, mas o campo YAML esta vazio.",
            };
        }

        const yamlParse = parseYamlModel(yamlText);
        if (yamlParse.error) {
            return {
                error: yamlParse.error,
            };
        }

        try {
            const modelBlueprint = normalizeModel(yamlParse.model);
            const rngSource = createRngFromYaml(yamlParse.model, params);
            return {
                error: "",
                modelBlueprint,
                rngSource,
                modeLabel: "YAML (M8)",
            };
        } catch (error) {
            return {
                error: error.message,
            };
        }
    }

    const lcgValidation = validateLcgParams(params);
    if (lcgValidation) {
        return {
            error: lcgValidation,
        };
    }

    const legacyValidation = validateLegacyQueueParams(params);
    if (legacyValidation) {
        return {
            error: legacyValidation,
        };
    }

    try {
        const legacyModel = buildLegacyModel(params);
        const modelBlueprint = normalizeModel(legacyModel);
        const rngSource = createLegacyRng(params);
        return {
            error: "",
            modelBlueprint,
            rngSource,
            modeLabel: "Legado tandem",
        };
    } catch (error) {
        return {
            error: error.message,
        };
    }
}

// Compute visit rates and utilizations for the network and detect instability.
function computeNetworkUtilization(modelBlueprint) {
    try {
        const queueOrder = modelBlueprint.queueOrder;
        const n = queueOrder.length;
        if (n === 0) return { error: "" };

        // external arrival rates (per time unit) based on mean interarrival
        const e = new Array(n).fill(0);
        for (let i = 0; i < n; i += 1) {
            const q = modelBlueprint.queueBlueprints.get(queueOrder[i]);
            if (q.minArrival !== null && q.maxArrival !== null) {
                const meanInter = (q.minArrival + q.maxArrival) / 2;
                if (meanInter <= 0) return { error: `Fila ${q.id}: mean interarrival deve ser > 0.` };
                e[i] = 1 / meanInter;
            }
        }

        // build routing probability matrix P (source rows -> dest cols)
        const P = Array.from({ length: n }, () => new Array(n).fill(0));
        for (let i = 0; i < n; i += 1) {
            const q = modelBlueprint.queueBlueprints.get(queueOrder[i]);
            for (const r of q.routes) {
                if (r.destination === EXTERNAL_QUEUE_ID) continue;
                const j = queueOrder.indexOf(String(r.destination));
                if (j >= 0) P[i][j] = P[i][j] + Number(r.probability);
            }
        }

        // Solve v = e + v * P  => (I - P^T) * v_col = e_col
        // Build A = I - P^T
        const A = Array.from({ length: n }, (_, i) => new Array(n).fill(0));
        for (let i = 0; i < n; i += 1) {
            for (let j = 0; j < n; j += 1) {
                A[i][j] = (i === j ? 1 : 0) - P[j][i];
            }
        }

        // clone e into b
        const b = e.slice();

        // Solve linear system A x = b via Gaussian elimination with partial pivot
        const M = A.map((row) => row.slice());
        const rhs = b.slice();

        for (let k = 0; k < n; k += 1) {
            // partial pivot
            let maxRow = k;
            for (let i = k + 1; i < n; i += 1) {
                if (Math.abs(M[i][k]) > Math.abs(M[maxRow][k])) maxRow = i;
            }
            if (Math.abs(M[maxRow][k]) < 1e-12) {
                return { error: "Rede singular ou instavel (matriz I-P^T singular)." };
            }
            // swap
            [M[k], M[maxRow]] = [M[maxRow], M[k]];
            [rhs[k], rhs[maxRow]] = [rhs[maxRow], rhs[k]];

            // eliminate
            for (let i = k + 1; i < n; i += 1) {
                const factor = M[i][k] / M[k][k];
                for (let j = k; j < n; j += 1) M[i][j] -= factor * M[k][j];
                rhs[i] -= factor * rhs[k];
            }
        }

        // back substitution
        const x = new Array(n).fill(0);
        for (let i = n - 1; i >= 0; i -= 1) {
            let sum = rhs[i];
            for (let j = i + 1; j < n; j += 1) sum -= M[i][j] * x[j];
            x[i] = sum / M[i][i];
        }

        // compute utilizations
        const unstable = [];
        for (let i = 0; i < n; i += 1) {
            const q = modelBlueprint.queueBlueprints.get(queueOrder[i]);
            const meanService = (q.minService + q.maxService) / 2;
            const visitsPerTime = x[i];
            const rho = (visitsPerTime * meanService) / q.servers;
            if (!Number.isFinite(rho)) return { error: `Fila ${q.id}: utilizacao invalida.` };
            if (rho >= 1 - 1e-9) {
                unstable.push({ id: q.id, rho, visitsPerTime, meanService, servers: q.servers });
            }
        }

        if (unstable.length > 0) {
            const lines = unstable.map((u) => `Fila ${u.id}: utilizacao=${u.rho.toFixed(4)} (visitas=${u.visitsPerTime.toFixed(4)}, tempoMedioServico=${u.meanService})`);
            const msg = `Rede potencialmente instavel. Ajuste tempos de servico, probabilidades de roteamento ou servidores.\n` + lines.join("\n");
            return { error: msg };
        }

        return { error: "" };
    } catch (err) {
        return { error: `Erro calculando estabilidade: ${err.message}` };
    }
}

function executeSimulation() {
    const errorNode = document.getElementById("error");
    const params = readParams();
    // Force YAML-only mode: the newer YAML-driven model is the single supported mode
    const useYaml = true;

    const setup = resolveSimulationSetup(params, useYaml);
    if (setup.error) {
        errorNode.textContent = setup.error;
        return;
    }

    errorNode.textContent = "";
    // Production mode: no debug traces

    lastResult = runSimulation(setup.modelBlueprint, setup.rngSource);

    statesTableLimit = DEFAULT_TABLE_LIMIT;
    scheduleTableLimit = DEFAULT_TABLE_LIMIT;
    setLimitToggleLabel("toggle-states-limit", statesTableLimit);
    setLimitToggleLabel("toggle-schedule-limit", scheduleTableLimit);

    renderMetrics(lastResult, setup.modeLabel);
    renderQueueMetrics(lastResult);
    renderStates(lastResult);
    renderScheduler(lastResult);
    renderQueueStateSections(lastResult);

    const isLcgVisible = document.getElementById("lcg-accordion-toggle")?.getAttribute("aria-expanded") === "true";
    if (isLcgVisible) {
        renderLcgDistributionChart(params);
    }

    // no debug dump generation in production mode
}

function loadMinimumScenario() {
    document.getElementById("seed").value = "42";
    document.getElementById("multiplier").value = "39758";
    document.getElementById("increment").value = "58739";
    document.getElementById("modulus").value = "987654321";
    document.getElementById("count").value = "100000";
    // Attempt to load ../model.yml into the YAML textarea and run the simulation
    loadRepositoryModelYaml();
}

function scheduleExecuteSimulation() {
    window.clearTimeout(regenerateTimeoutId);
    regenerateTimeoutId = window.setTimeout(() => {
        executeSimulation();
    }, AUTO_REGENERATE_DELAY);
}

function setupAutoRegeneration() {
    const fields = [
        "seed",
        "multiplier",
        "increment",
        "modulus",
        "count",
        "first-arrival",
        "f1-min-arrival",
        "f1-max-arrival",
        "f1-min-service",
        "f1-max-service",
        "f1-servers",
        "f1-capacity",
        "f2-min-service",
        "f2-max-service",
        "f2-servers",
        "f2-capacity",
        "yaml-config",
    ];

    fields.forEach((id) => {
        const node = document.getElementById(id);
        if (!node) {
            return;
        }

        node.addEventListener("blur", scheduleExecuteSimulation);
        node.addEventListener("change", scheduleExecuteSimulation);
        node.addEventListener("input", scheduleExecuteSimulation);
    });
}

// Visual editor has been removed; configuration is YAML-only.

// Visual editor controls removed from the UI in YAML-only mode.

// YAML mode radios removed; use "Carregar model.yml do repositorio" to reset, edit YAML manually, or edit via visual editor.

// initialize visual editor and sync
document.addEventListener("DOMContentLoaded", () => {
    // Start by loading repo defaults into visual editor (if available)
    loadRepositoryModelYaml();
});

document.getElementById("run")?.addEventListener("click", executeSimulation);

document.getElementById("scenario-minimum")?.addEventListener("click", () => {
    loadMinimumScenario();
    executeSimulation();
});

document.getElementById("download-csv")?.addEventListener("click", () => {
    if (!lastResult) {
        executeSimulation();
    }
    if (lastResult) {
        exportCsv(lastResult);
    }
});

document.getElementById("load-model-yaml")?.addEventListener("click", () => {
    loadRepositoryModelYaml();
});

// generate-yaml button removed; visual editor auto-sync handles YAML generation

// clear-yaml button removed; users can edit textarea directly

document.getElementById("toggle-states-limit")?.addEventListener("click", () => {
    if (!lastResult) {
        executeSimulation();
        return;
    }

    statesTableLimit = statesTableLimit === DEFAULT_TABLE_LIMIT ? EXPANDED_TABLE_LIMIT : DEFAULT_TABLE_LIMIT;
    setLimitToggleLabel("toggle-states-limit", statesTableLimit);
    renderStates(lastResult);
});

document.getElementById("toggle-schedule-limit")?.addEventListener("click", () => {
    if (!lastResult) {
        executeSimulation();
        return;
    }

    scheduleTableLimit = scheduleTableLimit === DEFAULT_TABLE_LIMIT ? EXPANDED_TABLE_LIMIT : DEFAULT_TABLE_LIMIT;
    setLimitToggleLabel("toggle-schedule-limit", scheduleTableLimit);
    renderScheduler(lastResult);
});

window.addEventListener("DOMContentLoaded", () => {
    setupLcgAccordion();
    setupAutoRegeneration();
    loadMinimumScenario();
    executeSimulation();
});