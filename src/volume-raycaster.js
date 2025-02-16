import { ArcballCamera } from "arcball_camera";
import { Controller } from "ez_canvas_controller";
import { mat4, vec3 } from "gl-matrix";

import shaderCode from "./shaders.wgsl";
import {
  colormaps,
  fetchVolume,
  fillSelector,
  getCubeMesh,
  getVolumeDimensions,
  uploadData,
  uploadImage,
  uploadRadarVolume,
  uploadVolume,
  volumes,
} from "./volume.js";

(async () => {
  if (navigator.gpu === undefined) {
    document
      .getElementById("webgpu-canvas")
      .setAttribute("style", "display:none;");
    document
      .getElementById("no-webgpu")
      .setAttribute("style", "display:block;");
    return;
  }

  var adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    document
      .getElementById("webgpu-canvas")
      .setAttribute("style", "display:none;");
    document
      .getElementById("no-webgpu")
      .setAttribute("style", "display:block;");
    return;
  }
  var device = await adapter.requestDevice();

  // Get a context to display our rendered image on the canvas
  var canvas = document.getElementById("webgpu-canvas");
  var context = canvas.getContext("webgpu");

  // Setup shader modules
  var shaderModule = device.createShaderModule({ code: shaderCode });
  var compilationInfo = await shaderModule.compilationInfo();
  if (compilationInfo.messages.length > 0) {
    var hadError = false;
    console.log("Shader compilation log:");
    for (var i = 0; i < compilationInfo.messages.length; ++i) {
      var msg = compilationInfo.messages[i];
      console.log(`${msg.lineNum}:${msg.linePos} - ${msg.message}`);
      hadError = hadError || msg.type == "error";
    }
    if (hadError) {
      console.log("Shader failed to compile");
      return;
    }
  }

  const defaultEye = vec3.set(vec3.create(), 0.0, 0.0, 2.0);
  const center = vec3.set(vec3.create(), 0.0, 0.0, 0.0);
  const up = vec3.set(vec3.create(), 0.0, 1.0, 0.0);

  const cube = getCubeMesh();

  // Upload cube to use to trigger raycasting of the volume
  var vertexBuffer = device.createBuffer({
    size: cube.vertices.length * 4,
    usage: GPUBufferUsage.VERTEX,
    mappedAtCreation: true,
  });
  new Float32Array(vertexBuffer.getMappedRange()).set(cube.vertices);
  vertexBuffer.unmap();

  var indexBuffer = device.createBuffer({
    size: cube.indices.length * 4,
    usage: GPUBufferUsage.INDEX,
    mappedAtCreation: true,
  });
  new Uint16Array(indexBuffer.getMappedRange()).set(cube.indices);
  indexBuffer.unmap();

  // Create a buffer to store the view parameters
  var viewParamsBuffer = device.createBuffer({
    size: 20 * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  var sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });

  // const sampler = device.createSampler({
  //   addressModeU: "repeat",
  //   addressModeV: "repeat",
  //   magFilter: "linear",
  //   minFilter: "linear",
  //   mipmapFilter: "linear",
  // });

  var volumePicker = document.getElementById("volumeList");
  var colormapPicker = document.getElementById("colormapList");

  fillSelector(volumePicker, volumes);
  fillSelector(colormapPicker, colormaps);

  // Fetch and upload the volume
  var volumeName = "Bonsai";
  if (window.location.hash) {
    var linkedDataset = decodeURI(window.location.hash.substring(1));
    if (linkedDataset in volumes) {
      volumePicker.value = linkedDataset;
      volumeName = linkedDataset;
    } else {
      alert(`Linked to invalid data set ${linkedDataset}`);
      return;
    }
  }

  var colormapName = "dBZ Radarscope";
  var colormapTexture = await uploadImage(device, colormaps[colormapName]);

  var volumeDims = [500, 500, 40];
  // var volumeTexture = await fetchVolume(volumes[volumeName]).then(
  //   (volumeData) => {
  //     return uploadVolume(device, volumeDims, volumeData);
  //   }
  // );
  let volumeTexture = await uploadRadarVolume(device);

  var volumeDataBuffer = await uploadData(device);

  console.log(volumeDataBuffer);

  // Setup render outputs
  var swapChainFormat = "bgra8unorm";
  context.configure({
    device: device,
    format: swapChainFormat,
    usage: GPUTextureUsage.OUTPUT_ATTACHMENT,
    alphaMode: "premultiplied",
  });

  var bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "uniform" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { viewDimension: "3d" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { viewDimension: "2d" },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" },
      },
    ],
  });

  // Create render pipeline
  var layout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });

  var vertexState = {
    module: shaderModule,
    entryPoint: "vertex_main",
    buffers: [
      {
        arrayStride: 3 * 4,
        attributes: [{ format: "float32x3", offset: 0, shaderLocation: 0 }],
      },
    ],
  };

  var fragmentState = {
    module: shaderModule,
    entryPoint: "fragment_main",
    targets: [
      {
        format: swapChainFormat,
        blend: {
          color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        },
      },
    ],
  };

  var renderPipeline = device.createRenderPipeline({
    layout: layout,
    vertex: vertexState,
    fragment: fragmentState,
    primitive: {
      topology: "triangle-strip",
      stripIndexFormat: "uint16",
      cullMode: "front",
    },
  });

  var renderPassDesc = {
    colorAttachments: [
      {
        view: undefined,
        loadOp: "clear",
        clearValue: [0.3, 0.3, 0.3, 1],
        storeOp: "store",
      },
    ],
  };

  var camera = new ArcballCamera(defaultEye, center, up, 2, [
    canvas.width,
    canvas.height,
  ]);
  var proj = mat4.perspective(
    mat4.create(),
    (30 * Math.PI) / 180.0,
    canvas.width / canvas.height,
    0.001,
    10
  );
  var projView = mat4.create();

  // Register mouse and touch listeners
  var controller = new Controller();
  controller.mousemove = function (prev, cur, evt) {
    if (evt.buttons == 1) {
      camera.rotate(prev, cur);
    } else if (evt.buttons == 2) {
      camera.pan([cur[0] - prev[0], prev[1] - cur[1]]);
    }
  };
  controller.wheel = function (amt) {
    camera.zoom(amt);
  };
  controller.pinch = controller.wheel;
  controller.twoFingerDrag = function (drag) {
    camera.pan(drag);
  };
  controller.registerForCanvas(canvas);

  var animationFrame = function () {
    var resolve = null;
    var promise = new Promise((r) => (resolve = r));
    window.requestAnimationFrame(resolve);
    return promise;
  };
  requestAnimationFrame(animationFrame);

  var bindGroupEntries = [
    { binding: 0, resource: { buffer: viewParamsBuffer } },
    { binding: 1, resource: volumeTexture.createView() },
    { binding: 2, resource: colormapTexture.createView() },
    { binding: 3, resource: sampler },
    { binding: 4, resource: { buffer: volumeDataBuffer } },
  ];
  var bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: bindGroupEntries,
  });

  var upload = device.createBuffer({
    size: 20 * 4,
    usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
    mappedAtCreation: false,
  });

  while (true) {
    await animationFrame();
    if (document.hidden) {
      continue;
    }

    // Fetch a new volume or colormap if a new one was selected
    // if (volumeName != volumePicker.value) {
    //   volumeName = volumePicker.value;
    //   history.replaceState(history.state, "", "#" + volumeName);

    //   volumeDims = getVolumeDimensions(volumes[volumeName]);

    //   volumeTexture = await fetchVolume(volumes[volumeName]).then(
    //     (volumeData) => {
    //       return uploadVolume(device, volumeDims, volumeData);
    //     }
    //   );

    //   //   const volumeData = await uploadData(device);

    //   bindGroupEntries[1].resource = volumeTexture.createView();
    //   bindGroup = device.createBindGroup({
    //     layout: bindGroupLayout,
    //     entries: bindGroupEntries,
    //   });
    // }

    if (colormapName != colormapPicker.value) {
      colormapName = colormapPicker.value;
      colormapTexture = await uploadImage(device, colormaps[colormapName]);

      bindGroupEntries[2].resource = colormapTexture.createView();
      bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: bindGroupEntries,
      });
    }

    // Update camera buffer
    projView = mat4.mul(projView, proj, camera.camera);

    {
      await upload.mapAsync(GPUMapMode.WRITE);
      var eyePos = camera.eyePos();
      var map = new Float32Array(upload.getMappedRange());
      map.set(projView);
      map.set(eyePos, projView.length);
      upload.unmap();
    }

    var commandEncoder = device.createCommandEncoder();
    commandEncoder.copyBufferToBuffer(upload, 0, viewParamsBuffer, 0, 20 * 4);

    renderPassDesc.colorAttachments[0].view = context
      .getCurrentTexture()
      .createView();
    var renderPass = commandEncoder.beginRenderPass(renderPassDesc);

    renderPass.setPipeline(renderPipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.setVertexBuffer(0, vertexBuffer);
    renderPass.setIndexBuffer(indexBuffer, "uint16");
    renderPass.draw(cube.vertices.length / 3, 1, 0, 0);

    renderPass.end();
    device.queue.submit([commandEncoder.finish()]);
  }
})();
