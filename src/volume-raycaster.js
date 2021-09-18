import {ArcballCamera} from "arcball_camera";
import {Controller} from "ez_canvas_controller";
import {mat4, vec3} from "gl-matrix";

import shaderCode from "./shaders.wgsl";
import {colormaps, fetchVolume, getCubeMesh, getVolumeDimensions, volumes} from "./volume.js";

(async () => {
    if (navigator.gpu === undefined) {
        document.getElementById("webgpu-canvas").setAttribute("style", "display:none;");
        document.getElementById("no-webgpu").setAttribute("style", "display:block;");
        return;
    }

    const defaultEye = vec3.set(vec3.create(), 0.5, 0.5, 2.5);
    const center = vec3.set(vec3.create(), 0.5, 0.5, 0.5);
    const up = vec3.set(vec3.create(), 0.0, 1.0, 0.0);

    // Get a GPU device to render with
    var adapter = await navigator.gpu.requestAdapter();
    var device = await adapter.requestDevice();

    // Get a context to display our rendered image on the canvas
    var canvas = document.getElementById("webgpu-canvas");
    var context = canvas.getContext("webgpu");

    // Setup shader modules
    var shaderModule = device.createShaderModule({code: shaderCode});
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

    const cube = getCubeMesh();

    // Upload cube to use to trigger raycasting of the volume
    var vertexBuffer = device.createBuffer({
        size: cube.vertices.length * 4,
        usage: GPUBufferUsage.VERTEX,
        mappedAtCreation: true
    });
    new Float32Array(vertexBuffer.getMappedRange()).set(cube.vertices);
    vertexBuffer.unmap();

    var indexBuffer = device.createBuffer(
        {size: cube.indices.length * 4, usage: GPUBufferUsage.INDEX, mappedAtCreation: true});
    new Uint16Array(indexBuffer.getMappedRange()).set(cube.indices);
    indexBuffer.unmap();

    // Create a buffer to store the view parameters
    var viewParamsBuffer = device.createBuffer(
        {size: 20 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});

    var sampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
    });

    // Upload the colormap texture
    var colormapTexture = null;
    {
        var colormapImage = new Image();
        colormapImage.src = colormaps["Cool Warm"];
        await colormapImage.decode();
        var imageBitmap = await createImageBitmap(colormapImage);

        colormapTexture = device.createTexture({
            size: [imageBitmap.width, imageBitmap.height, 1],
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
                       GPUTextureUsage.RENDER_ATTACHMENT
        });

        var src = {source: imageBitmap};
        var dst = {texture: colormapTexture};
        device.queue.copyExternalImageToTexture(
            src, dst, [imageBitmap.width, imageBitmap.height]);
    }

    // Fetch and upload the volume
    var volumeName = "Foot";
    var volumeDims = getVolumeDimensions(volumes[volumeName]);
    var volumeTexture = device.createTexture({
        size: volumeDims,
        format: "r8unorm",
        dimension: "3d",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    {
        var volumeData = await fetchVolume(volumes[volumeName]);

        var volumeUploadBuf = device.createBuffer(
            {size: volumeData.length, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true});
        new Uint8Array(volumeUploadBuf.getMappedRange()).set(volumeData);
        volumeUploadBuf.unmap();

        var commandEncoder = device.createCommandEncoder();

        var src = {
            buffer: volumeUploadBuf,
            // NOTE: bytes per row must be multiple of 256
            bytesPerRow: volumeDims[0],
            rowsPerImage: volumeDims[1]
        };
        var dst = {texture: volumeTexture};
        commandEncoder.copyBufferToTexture(src, dst, volumeDims);

        await device.queue.submit([commandEncoder.finish()]);
    }

    // Setup render outputs
    var swapChainFormat = "bgra8unorm";
    context.configure(
        {device: device, format: swapChainFormat, usage: GPUTextureUsage.OUTPUT_ATTACHMENT});

    var bindGroupLayout = device.createBindGroupLayout({
        entries: [
            {binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {type: "uniform"}},
            {binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {viewDimension: "3d"}},
            {binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {viewDimension: "2d"}},
            {binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {type: "filtering"}}
        ]
    });

    var viewParamBG = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
            {binding: 0, resource: {buffer: viewParamsBuffer}},
            {binding: 1, resource: volumeTexture.createView()},
            {binding: 2, resource: colormapTexture.createView()},
            {binding: 3, resource: sampler},
        ]

    });

    // Create render pipeline
    var layout = device.createPipelineLayout({bindGroupLayouts: [bindGroupLayout]});

    var vertexState = {
        module: shaderModule,
        entryPoint: "vertex_main",
        buffers: [{
            arrayStride: 3 * 4,
            attributes: [{format: "float32x3", offset: 0, shaderLocation: 0}]
        }]
    };

    var fragmentState = {
        module: shaderModule,
        entryPoint: "fragment_main",
        targets: [{
            format: swapChainFormat,
            blend: {
                color: {srcFactor: "one", dstFactor: "one-minus-src-alpha"},
                alpha: {srcFactor: "one", dstFactor: "one-minus-src-alpha"}
            }
        }]
    };

    var renderPipeline = device.createRenderPipeline({
        layout: layout,
        vertex: vertexState,
        fragment: fragmentState,
        primitive: {
            topology: "triangle-strip",
            stripIndexFormat: "uint16",
            cullMode: "front",
        }
    });

    var renderPassDesc = {
        colorAttachments: [{view: undefined, loadValue: [0.3, 0.3, 0.3, 1]}]
    };

    var camera = new ArcballCamera(defaultEye, center, up, 2, [canvas.width, canvas.height]);
    var proj = mat4.perspective(
        mat4.create(), 50 * Math.PI / 180.0, canvas.width / canvas.height, 0.1, 100);
    var projView = mat4.create();

    // Register mouse and touch listeners
    var controller = new Controller();
    controller.mousemove = function(prev, cur, evt) {
        if (evt.buttons == 1) {
            camera.rotate(prev, cur);

        } else if (evt.buttons == 2) {
            camera.pan([cur[0] - prev[0], prev[1] - cur[1]]);
        }
    };
    controller.wheel = function(amt) {
        camera.zoom(amt);
    };
    controller.pinch = controller.wheel;
    controller.twoFingerDrag = function(drag) {
        camera.pan(drag);
    };
    controller.registerForCanvas(canvas);

    var frame = function() {
        if (!document.hidden) {
            // Update camera buffer
            projView = mat4.mul(projView, proj, camera.camera);

            var upload = device.createBuffer(
                {size: 20 * 4, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true});
            {
                var eyePos = camera.eyePos();
                var map = new Float32Array(upload.getMappedRange());
                map.set(projView);
                map.set(eyePos, projView.length);
                upload.unmap();
            }

            var commandEncoder = device.createCommandEncoder();
            commandEncoder.copyBufferToBuffer(upload, 0, viewParamsBuffer, 0, 20 * 4);

            renderPassDesc.colorAttachments[0].view = context.getCurrentTexture().createView();
            var renderPass = commandEncoder.beginRenderPass(renderPassDesc);

            renderPass.setPipeline(renderPipeline);
            renderPass.setBindGroup(0, viewParamBG);
            renderPass.setVertexBuffer(0, vertexBuffer);
            renderPass.setIndexBuffer(indexBuffer, "uint16");
            renderPass.draw(cube.vertices.length / 3, 1, 0, 0);

            renderPass.endPass();
            device.queue.submit([commandEncoder.finish()]);
        }
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
})();
