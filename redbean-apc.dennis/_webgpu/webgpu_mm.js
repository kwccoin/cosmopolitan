var best = 0;

function log(...args) {
  const in1 = document.getElementById('in1');
  const out = document.getElementById('out');
  const s = document.createElement('div');
  for (let arg of args) {
    s.textContent += arg + ' ';
  }
  out.appendChild(s);
}

function mm_ref(A, B, C, M, N, K) {
  for (let m = 0; m < M; ++m) {
    for (let n = 0; n < N; ++n) {
      let res = 0;
      for (let k = 0; k < K; ++k) {
        res += A[m * K + k] * B[k * N + n];
      }
      C[m * N + n] = res;
    }
  }
}

async function check(device, M, N, K, opt) {
  const mm = createMatrixMultiplication(device, M, N, K, opt);
  const [A, A_cpu] = randGPU(device, M * K, true);
  const [B, B_cpu] = randGPU(device, K * N, true);
  const [C, C_cpu] = randGPU(device, M * N, true);
  device.getQueue().submit([mm(A, B, C)]);
  const gpu_out = await toCPU(device, C, M * N);
  mm_ref(A_cpu, B_cpu, C_cpu, M, N, K);
  let max_diff = 0;
  for (let i = 0; i < M * N; ++i) {
    const diff = Math.abs(gpu_out[i] - C_cpu[i]);
    console.assert(diff < 0.0001);
    if (diff > max_diff) {
      max_diff = diff;
    }
  }
  if (max_diff < 0.0001) {
    //log("pass! max diff:", max_diff);
    return true;
  } else {
    log("fail! max diff:", max_diff);
    console.log(gpu_out, C_cpu);
    return false;
  }
}

function randGPU(device, numel, return_cpu_ref = false) {
  const [gpu, cpu] = device.createBufferMapped({
    size: numel * 4, // sizeof float
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  let rand = new Float32Array(numel);
  for (let i = 0; i < numel; ++i) {
    rand[i] = Math.random() / 511.91;
  }
  new Float32Array(cpu).set(rand);
  gpu.unmap();
  if (return_cpu_ref) {
    return [gpu, rand];
  }
  return gpu;
}

async function toCPU(device, gpu_array, numel) {
  const buffer = device.createBuffer({
    size: numel * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const commandEncoder = device.createCommandEncoder();
  commandEncoder.copyBufferToBuffer(gpu_array, 0, buffer, 0, numel * 4);
  device.getQueue().submit([commandEncoder.finish()]);

  return new Float32Array(await buffer.mapReadAsync());
}

function generateMatrixMultiplicationKernelOpt(M, N, K, opt) {
  if (opt.use_matrix) {
    return __generateMatrixMultiplicationKernelOpt(M, N, K, opt);
  }
  if (opt.vec_width > opt.n_unroll) {
    log("error generating kernel. check options");
    return "";
  }
  let A_type = 'float4';
  if (opt.k_unroll == 1) {
    A_type = 'float';
  }
  
  let source = ``;
  if (opt.swap_threads) {
    source += `[numthreads(${opt.y_threads}, ${opt.x_threads}, 1)]`;
  } else {
    source += `[numthreads(${opt.x_threads}, ${opt.y_threads}, 1)]`;
  }

  source += `
compute void main(constant ${A_type}[] A : register(u0),
                  constant float4[] B : register(u1),
                  device float4[] C : register(u2),
                  float3 threadID : SV_DispatchThreadID) {`;
  if (opt.swap_threads) {
    source += `
  uint n = uint(threadID.x);
  uint m = uint(threadID.y);\n`;
  } else {
    source += `
  uint m = uint(threadID.x);
  uint n = uint(threadID.y);\n`;
  }
  for (let m = 0; m < opt.m_unroll; ++m) {
    for (let n = 0; n < opt.n_unroll / opt.vec_width; ++n) {
      source += `
  float4 result_${m}_${n} = float4(0.0, 0.0, 0.0, 0.0);`;
    }
  }
  source += `
  for (uint k = 0; k < ${K / opt.k_unroll}; k++) {`;
  for (let m = 0; m < opt.m_unroll; ++m) {
    for (let k = 0; k < Math.max(opt.k_unroll / opt.vec_width, 1); ++k) {
      const idx = `(m * ${opt.m_unroll} + ${m}) * ${K / opt.vec_width} + (k * ${opt.k_unroll / opt.vec_width} + ${k})`;
      source += `
    ${A_type} a_${m}_${k} = A[${idx}];`;
    }
  }
  for (let n = 0; n < opt.n_unroll / opt.vec_width; ++n) {
    for (let k = 0; k < opt.k_unroll; ++k) {
      const idx = `(k * ${opt.k_unroll} + ${k}) * ${N / opt.vec_width} + (n * ${opt.n_unroll / opt.vec_width} + ${n})`;
      source += `
    float4 b_${n}_${k} = B[${idx}];`;
    }
  }
  if (opt.use_mad) { // have to unroll to use mad
    for (let m = 0; m < opt.m_unroll; ++m) {
      for (let k = 0; k < Math.max(opt.k_unroll / opt.vec_width, 1); ++k) {
        if (opt.k_unroll == 1) {
          source += `
    float4 a_${m}_${k}_v = float4(a_${m}_${k}, a_${m}_${k}, a_${m}_${k}, a_${m}_${k});`;
        } else {
          source += `
    float4 a_${m}_${k}_x = float4(a_${m}_${k}.x, a_${m}_${k}.x, a_${m}_${k}.x, a_${m}_${k}.x);
    float4 a_${m}_${k}_y = float4(a_${m}_${k}.y, a_${m}_${k}.y, a_${m}_${k}.y, a_${m}_${k}.y);
    float4 a_${m}_${k}_z = float4(a_${m}_${k}.z, a_${m}_${k}.z, a_${m}_${k}.z, a_${m}_${k}.z);
    float4 a_${m}_${k}_w = float4(a_${m}_${k}.w, a_${m}_${k}.w, a_${m}_${k}.w, a_${m}_${k}.w);`
        }
      }
    }
  }
  if (opt.k_unroll == 1) {
    for (let k = 0; k < Math.max(opt.k_unroll / opt.vec_width, 1); ++k) {
      for (let n = 0; n < opt.n_unroll / opt.vec_width; ++n) {
        for (let m = 0; m < opt.m_unroll; ++m) {
          if (opt.use_mad) {
            source += `
    result_${m}_${n} = mad(a_${m}_${k}_v, b_${n}_${k}, result_${m}_${n});`
          } else {
            source += `
    result_${m}_${n} += mul(a_${m}_${k}.v, b_${n}_${k});`
          }
        }
      }
    }
  } else {
    const lets = ['x', 'y', 'z', 'w'];
    for (let l of lets) {
      for (let k = 0; k < Math.max(opt.k_unroll / opt.vec_width, 1); ++k) {
        for (let n = 0; n < opt.n_unroll / opt.vec_width; ++n) {
          for (let m = 0; m < opt.m_unroll; ++m) {
            if (opt.use_mad) {
              source += `
    result_${m}_${n} = mad(a_${m}_${k}_${l}, b_${n}_${k * opt.vec_width + lets.indexOf(l)}, result_${m}_${n});`;
            } else {
              source += `
    result_${m}_${n} += mul(a_${m}_${k}.${l}, b_${n}_${k * opt.vec_width + lets.indexOf(l)});`;
            }
          }
        }
      }
    }
  }
  source += `
  }`;
  for (let n = 0; n < opt.n_unroll / opt.vec_width; ++n) {
    for (let m = 0; m < opt.m_unroll; ++m) {
      const idx = `(m * ${opt.m_unroll} + ${m}) * ${N / opt.vec_width} + (n * ${opt.n_unroll / opt.vec_width} + ${n})`;
      source += `
  C[${idx}] = result_${m}_${n};`;
    }
  }
  source += `\n}`;
  const dispatch = [M / opt.x_threads / opt.m_unroll, N / opt.y_threads / opt.n_unroll, 1];
  if (opt.swap_threads) {
    const x = dispatch[0];
    const y = dispatch[1];
    dispatch[0] = y;
    dispatch[1] = x;
  }
  return [source, dispatch];
}

// use matrices instead of vectors
function __generateMatrixMultiplicationKernelOpt(M, N, K, opt) {
  let source = ``;
  source += `[numthreads(${opt.x_threads}, ${opt.y_threads}, 1)]`;
  source += `
compute void main(constant float4[] A : register(u0),
                  constant float4[] B : register(u1),
                  device float4[] C : register(u2),
                  float3 threadID : SV_DispatchThreadID) {`;
    source += `
  uint m = uint(threadID.x);
  uint n = uint(threadID.y);\n`;
  for (let m = 0; m < opt.m_unroll / opt.vec_width; ++m) {
    for (let n = 0; n < opt.n_unroll / opt.vec_width; ++n) {

      source += `
  float4x4 result_${m}_${n} = float4x4(${"0.0, ".repeat(15)}0.0);`;
    }
  }

  source += `
  for (uint k = 0; k < ${K / opt.k_unroll}; k++) {`;

  // load A vecs
  for (let m = 0; m < opt.m_unroll; ++m) {
    for (let k = 0; k < opt.k_unroll / opt.vec_width; ++k) {
      const idx = `(m * ${opt.m_unroll} + ${m}) * ${K / opt.vec_width} + (k * ${opt.k_unroll / opt.vec_width} + ${k})`;
      source += `
    float4 a_${m}_${k} = A[${idx}];`;
    }
  }
  // make A matrices
  for (let m = 0; m < opt.m_unroll / opt.vec_width; ++m) {
    for (let k = 0; k < opt.k_unroll / opt.vec_width; ++k) {
      source += `
    float4x4 a_m_${m}_${k} = float4x4(`;
      for (let i = 0; i < opt.vec_width; ++i) {
        source += `a_${m * opt.vec_width + i}_${k}`;
        if (i != opt.vec_width - 1) {
          source += `, `;
        }
      }
      source += `);`;
    }
  }
  // load B vecs
  for (let n = 0; n < opt.n_unroll / opt.vec_width; ++n) {
    for (let k = 0; k < opt.k_unroll; ++k) {
      const idx = `(k * ${opt.k_unroll} + ${k}) * ${N / opt.vec_width} + (n * ${opt.n_unroll / opt.vec_width} + ${n})`;
      source += `
    float4 b_${n}_${k} = B[${idx}];`;
    }
  }
  for (let n = 0; n < opt.n_unroll / opt.vec_width; ++n) {
    for (let k = 0; k < opt.k_unroll / opt.vec_width; ++k) {
      source += `
    float4x4 b_m_${n}_${k} = float4x4(`;
      for (let i = 0; i < opt.vec_width; ++i) {
        source += `b_${n}_${k * opt.vec_width + i}`;
        if (i != opt.vec_width - 1) {
          source += `, `;
        }
      }
      source += `);`;
    }
  }

  // multiply matrices
  for (let n = 0; n < opt.n_unroll / opt.vec_width; ++n) {
    for (let m = 0; m < opt.m_unroll / opt.vec_width; ++m) {
      for (let k = 0; k < opt.k_unroll / opt.vec_width; ++k) {
        source += `
    result_${m}_${n} += mul(b_m_${n}_${k}, a_m_${m}_${k});`
      }
    }
  }

  source += `
  }`; // k

  // write to C
  for (let m = 0; m < opt.m_unroll / opt.vec_width; ++m) {
    for (let n = 0; n < opt.n_unroll / opt.vec_width; ++n) {
      for (let i = 0; i < opt.vec_width; ++i) {
        const idx = `(m * ${opt.m_unroll} + ${m * opt.vec_width + i}) * ${N / opt.vec_width} + (n * ${opt.n_unroll / opt.vec_width} + ${n})`;
        source += `
  C[${idx}] = result_${m}_${n}[${i}];`
      }
    }
  }
  

  source += `
}`; // main
  const dispatch = [M / opt.x_threads / opt.m_unroll, N / opt.y_threads / opt.n_unroll, 1];
  return [source, dispatch];
}

function _generateMatrixMultiplicationKernelOpt(M, N, K, opt) {
  let source = `
[numthreads(8, 8, 1)]
compute void main(constant float4[] A: register(u0),
                  constant float4[] B: register(u1),
                  device float4[] C: register(u2),
                  float3 threadID : SV_DispatchThreadID) {
  uint m = uint(threadID.x);
  uint n = uint(threadID.y);
  float4x4 result = float4x4(
    0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0);
  for (uint k = 0; k < ${K / 4}; ++k) {
    float4 a0 = A[(m * 4 + 0) * ${K / 4} + k];
    float4 a1 = A[(m * 4 + 1) * ${K / 4} + k];
    float4 a2 = A[(m * 4 + 2) * ${K / 4} + k];
    float4 a3 = A[(m * 4 + 3) * ${K / 4} + k];

    float4 b0 = B[(k * 4 + 0) * ${N / 4} + n];
    float4 b1 = B[(k * 4 + 1) * ${N / 4} + n];
    float4 b2 = B[(k * 4 + 2) * ${N / 4} + n];
    float4 b3 = B[(k * 4 + 3) * ${N / 4} + n];

    float4x4 b = float4x4(b0, b1, b2, b3);
    float4x4 a = float4x4(a0, a1, a2, a3);

    result += mul(b, a);
  }
  C[(m * 4 + 0) * ${N / 4} + n] = result[0];
  C[(m * 4 + 1) * ${N / 4} + n] = result[1];
  C[(m * 4 + 2) * ${N / 4} + n] = result[2];
  C[(m * 4 + 3) * ${N / 4} + n] = result[3];
}
`;
  const dispatch = [M / 8 / 4, N / 8 / 4, 1];
  return [source, dispatch];
}

function createMatrixMultiplication(device, M, N, K, opt) {

  // BindGroupLayout

  const visibility = GPUShaderStage.COMPUTE;
  const type = "storage-buffer";

  const bindGroupLayout = device.createBindGroupLayout({
    bindings: [
      { binding: 0, visibility: visibility, type: type },
      { binding: 1, visibility: visibility, type: type },
      { binding: 2, visibility: visibility, type: type },
    ]
  });

  // PipelineLayout

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });

  // ComputePipeline

  const [source, dispatch] = generateMatrixMultiplicationKernelOpt(M, N, K, opt);

  const computePipeline = device.createComputePipeline({
    layout: pipelineLayout,
    computeStage: {
      module: device.createShaderModule({
        code: source,
      }),
      entryPoint: "main"
    }
  });

  // define the mm function

  function mm(A, B, C) {
    const commandEncoder = device.createCommandEncoder();
    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      bindings: [
        { binding: 0, resource: { buffer: A, size: M * K * 4 } },
        { binding: 1, resource: { buffer: B, size: N * K * 4 } },
        { binding: 2, resource: { buffer: C, size: M * N * 4 } },
      ]
    });

    const passEncoder = commandEncoder.beginComputePass();
    passEncoder.setPipeline(computePipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.dispatch(dispatch[0], dispatch[1], dispatch[2]);
    passEncoder.endPass();
    return commandEncoder.finish();
  }

  return mm;
}

async function run(opt) {
  if (!navigator.gpu) {
    log("WebGPU not found.");
    return;
  }
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();

  const M = 1024;
  const N = 1024;
  const K = 1024;

  let f = await check(device, M / 4, N / 4, K / 4, opt);
  //let f = await check(device, M, N, K, opt);
  if (!f) {
    return;
  }

  const mm = createMatrixMultiplication(device, M, N, K, opt);

  let A = randGPU(device, M * K);
  let B = randGPU(device, K * N);
  let C = randGPU(device, M * N);

  // warmup
  device.getQueue().submit([
    mm(A, B, C),
    mm(C, B, A),
    mm(A, C, B),
    mm(B, A, C),
    mm(A, B, C),
    mm(C, B, A),
    mm(A, C, B),
    mm(B, A, C),
  ]);
  const warmup_res = await toCPU(device, C, M * N);
  console.log(warmup_res[0]);

  //log("benchmarking...");
  A = randGPU(device, M * K);
  B = randGPU(device, K * N);
  C = randGPU(device, M * N);
  const t0 = performance.now();
  device.getQueue().submit([
    mm(A, B, C),
    mm(C, B, A),
    mm(A, C, B),
    mm(B, A, C),
    mm(C, B, A),
    mm(A, B, C),
    mm(C, B, A),
    mm(A, C, B),
    mm(B, A, C),
    mm(C, B, A),
  ]);

  const result = await toCPU(device, C, M * N);
  console.log(result[0]);

  const t1 = performance.now();
  const flops = M * N * K * 2 * 10;
  const gflops = flops / ((t1 - t0) * 1e6);
  log("gflops:", gflops, "time:", t1 - t0);
  if (gflops > best) {
    best = gflops;
    let best_elem = document.getElementById('best');
    const [source, dispatch] = generateMatrixMultiplicationKernelOpt(M, N, K, opt);
    best_elem.textContent = 'best: ' + gflops.toFixed(2) + ' gflops\n' + source + '\n\n'
     + 'dispatch params: ' + dispatch;
  }
}

async function try_opts() {
  if (!navigator.gpu) {
    log("WebGPU not found. Be sure to use Safari and enable WebGPU in Develop > Experimental Features.");
    log(" ");
    log("If you don't have Safari, you can try TensorFlow's WebGL backend: https://jott.live/html/tf_mm.html");
    return;
  }
  log("Attempting to naively optimize matrix multiplication...\nattempts below:\n");
  for (let n of [4, 8, 16]) {
    for (let k of [4, 8, 16]) {
      for (let m of [2, 4, 8, 16]) {
        for (let x of [2, 4, 8, 16]) {
          for (let y of [2, 4, 8, 16]) {
            for (let use_matrix of [0, 1]) {
              for (let use_mad of [0, 1]) {
              if (use_matrix && (m < 4 || k < 4)) { continue; }
              // pretty much always bad to swap
              for (let swap of [0]) {
                const opt = { 
                  n_unroll: n,
                  m_unroll: m,
                  k_unroll: k,
                  x_threads : x,
                  y_threads : y,
                  matrix: use_matrix,
                  use_mad: use_mad,
                  swap_threads : swap,
                  vec_width: 4
                };
                log(`n: ${n} k: ${k} m: ${m} tx: ${x} ty: ${y} swap: ${swap} use matrix: ${use_matrix} use mad: ${use_mad}`);
                await run(opt);
              }
              }
            }
          }
        }
      }
    }
  }
}
window.addEventListener('load', try_opts);
