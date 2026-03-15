let scatterChart = null;
let lastGeneratedNumbers = [];
let currentTableLimit = 50;
let generateTimeoutId = null;

const AUTO_GENERATE_DELAY = 350;

const DEFAULT_PARAMS = {
	seed: 7,
	// seed: 42,
    a: 4,
    // a: 39758,
    c: 4,
    // c: 58739,
    m: 9,
    // m: 1000000,
    count: 1000,
};

const PARAM_KEYS = ["seed", "multiplier", "increment", "modulus", "count"];
const MODULUS_DEPENDENT_KEYS = ["seed", "multiplier", "increment"];

function normalizeBySliderConstraints(rawValue, slider) {
    const min = Number(slider.min);
    const max = Number(slider.max);
    const step = Number(slider.step) || 1;

    let value = Number(rawValue);
    if (!Number.isFinite(value)) {
        value = Number(slider.value) || min;
    }

    value = Math.min(max, Math.max(min, value));
    value = min + Math.round((value - min) / step) * step;
    value = Math.min(max, Math.max(min, value));

    return Math.round(value);
}

function setParameterValue(key, rawValue) {
    const slider = document.getElementById(key);
    const numberInput = document.getElementById(`${key}-value`);
    if (!slider || !numberInput) {
        return;
    }

    const normalizedValue = normalizeBySliderConstraints(rawValue, slider);
    slider.value = normalizedValue;
    numberInput.value = normalizedValue;

    if (key === "modulus") {
        updateDependentParameterLimits(normalizedValue);
    }
}

function updateDependentParameterLimits(modulusRawValue) {
    const modulus = Number(modulusRawValue);
    if (!Number.isFinite(modulus) || modulus <= 0) {
        return;
    }

    const dynamicMax = Math.max(0, modulus - 1);

    MODULUS_DEPENDENT_KEYS.forEach((key) => {
        const slider = document.getElementById(key);
        const numberInput = document.getElementById(`${key}-value`);
        if (!slider || !numberInput) {
            return;
        }

        slider.max = dynamicMax;
        numberInput.max = dynamicMax;

        setParameterValue(key, slider.value);
    });
}

function scheduleGenerateAndRender() {
    window.clearTimeout(generateTimeoutId);
    generateTimeoutId = window.setTimeout(() => {
        generateAndRender();
    }, AUTO_GENERATE_DELAY);
}

function setupParameterControls() {
    PARAM_KEYS.forEach((key) => {
        const slider = document.getElementById(key);
        const numberInput = document.getElementById(`${key}-value`);
        if (!slider || !numberInput) {
            return;
        }

        slider.addEventListener("input", () => {
            numberInput.value = slider.value;
            if (key === "modulus") {
                updateDependentParameterLimits(slider.value);
            }
        });

        slider.addEventListener("change", () => {
            setParameterValue(key, slider.value);
            scheduleGenerateAndRender();
        });

        const syncFromNumberInput = (shouldRegenerate = false) => {
            setParameterValue(key, numberInput.value);
            if (shouldRegenerate) {
                scheduleGenerateAndRender();
            }
        };

        numberInput.addEventListener("input", () => syncFromNumberInput(true));
        numberInput.addEventListener("change", () => syncFromNumberInput(true));
    });
}

function setDefaultParameters() {
    setParameterValue("modulus", DEFAULT_PARAMS.m);
    setParameterValue("seed", DEFAULT_PARAMS.seed);
    setParameterValue("multiplier", DEFAULT_PARAMS.a);
    setParameterValue("increment", DEFAULT_PARAMS.c);
    setParameterValue("count", DEFAULT_PARAMS.count);
}

function generateLCG(seed, a, c, m, count) {
    const sequence = [];
    let prevX = seed;

    for (let i = 0; i < count; i++) {
        const intermediate = a * prevX + c;
        const x = intermediate % m;
        sequence.push({ prevXi: prevX, intermediate, xi: x });
        prevX = x;
    }

    return sequence;
}

function buildScatterPairs(sequence) {
    const points = [];

    for (let i = 0; i < sequence.length - 1; i++) {
        points.push({ x: sequence[i], y: sequence[i + 1] });
    }

    return points;
}

function updateChart(points) {
    const ctx = document.getElementById("scatterPlot").getContext("2d");
    const rootStyles = getComputedStyle(document.documentElement);
    const pointColor = rootStyles.getPropertyValue("--accent-magenta").trim() || "#FF4FD8";

    if (scatterChart) {
        scatterChart.destroy();
    }

    scatterChart = new Chart(ctx, {
        type: "scatter",
        data: {
            datasets: [
                {
                    label: "Uᵢ x Uᵢ₊₁",
                    data: points,
                    pointRadius: 2,
                    showLine: false,
                    backgroundColor: pointColor,
                    borderColor: pointColor,
                },
            ],
        },
        options: {
            responsive: true,
            scales: {
                x: {
                    title: {
                        display: true,
                        text: "Uᵢ",
                    },
                },
                y: {
                    title: {
                        display: true,
                        text: "Uᵢ₊₁",
                    },
                },
            },
        },
    });
}

function populateTable(numbers, limit = 50) {
    const tableBody = document.getElementById("numbersTable");
    tableBody.innerHTML = "";

    numbers.slice(0, limit).forEach((item) => {
        const row = document.createElement("tr");
        row.innerHTML =
            `<td>${item.n}</td>` +
            `<td>${item.ui.toFixed(6)}</td>` +
            `<td>${item.xi}</td>` +
            `<td>${item.intermediate}</td>`;
        tableBody.appendChild(row);
    });
}

function exportCSV(numbers) {
    let csvContent = "i,U_i=X_i/M,X_i,a*X_(i-1)+c\n";
    numbers.forEach((item) => {
        csvContent += `${item.n},${item.ui.toFixed(6)},${item.xi},${item.intermediate}\n`;
    });

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "numeros_lcg.csv";
    link.click();

    URL.revokeObjectURL(url);
}

function exportChartPNG() {
    if (!scatterChart) {
        generateAndRender();
    }

    if (!scatterChart) {
        return;
    }

    const imageUrl = scatterChart.toBase64Image("image/png", 1);
    const link = document.createElement("a");
    link.href = imageUrl;
    link.download = "grafico_dispersao_lcg.png";
    link.click();
}

function getParameters() {
    return {
        seed: Number.parseInt(document.getElementById("seed").value, 10),
        a: Number.parseInt(document.getElementById("multiplier").value, 10),
        c: Number.parseInt(document.getElementById("increment").value, 10),
        m: Number.parseInt(document.getElementById("modulus").value, 10),
        count: Number.parseInt(document.getElementById("count").value, 10),
    };
}

function updateIntermediateHeader(a, c) {
    const intermediateHeader = document.getElementById("intermediate-header");
    if (!intermediateHeader) {
        return;
    }

    intermediateHeader.title = "aXᵢ₋₁ + c";
    intermediateHeader.innerHTML = `${a} × X<sub>i-1</sub> + ${c}`;
}

function generateAndRender() {
    const { seed, a, c, m, count } = getParameters();

    const steps = generateLCG(seed, a, c, m, count);
    updateIntermediateHeader(a, c);

    lastGeneratedNumbers = steps.map(({ prevXi, intermediate, xi }, idx) => ({
        n: idx + 1,
        prevXi,
        intermediate,
        xi,
        ui: xi / m,
    }));

    const normalizedValues = lastGeneratedNumbers.map((item) => item.ui);
    const points = buildScatterPairs(normalizedValues);
    updateChart(points);

    currentTableLimit = 50;
    const toggleBtn = document.getElementById("toggle-row-limit");
    if (toggleBtn) {
        toggleBtn.textContent = "Mostrar mais (1\u2009000)";
    }
    updateTableHint(currentTableLimit, lastGeneratedNumbers.length);
    populateTable(lastGeneratedNumbers, currentTableLimit);
}

document.getElementById("download").addEventListener("click", () => {
    if (lastGeneratedNumbers.length === 0) {
        generateAndRender();
    }
    exportCSV(lastGeneratedNumbers);
});

document.getElementById("download-chart").addEventListener("click", exportChartPNG);

function updateTableHint(limit, total) {
    const hint = document.querySelector(".table-hint");
    if (!hint) return;
    const shown = Math.min(limit, total);
    hint.innerHTML =
        `Exibindo os <strong>${shown.toLocaleString("pt-BR")} primeiros</strong> valores gerados. ` +
        `Alterne a quantidade de linhas vis\u00edveis com o bot\u00e3o ao lado, ou exporte a sequ\u00eancia completa em CSV.`;
}

document.getElementById("toggle-row-limit").addEventListener("click", () => {
    if (lastGeneratedNumbers.length === 0) {
        generateAndRender();
        return;
    }

    const toggleBtn = document.getElementById("toggle-row-limit");
    if (currentTableLimit === 50) {
        currentTableLimit = 1000;
        toggleBtn.textContent = "Mostrar menos (50)";
    } else {
        currentTableLimit = 50;
        toggleBtn.textContent = "Mostrar mais (1\u2009000)";
    }
    updateTableHint(currentTableLimit, lastGeneratedNumbers.length);
    populateTable(lastGeneratedNumbers, currentTableLimit);
});

window.addEventListener("DOMContentLoaded", () => {
    setupParameterControls();
    setDefaultParameters();
    generateAndRender();
});
