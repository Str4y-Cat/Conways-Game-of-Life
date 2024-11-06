/*
 * This is an attempt at conways game of life, using webGPU.
 *
 *
 */ 

const canvas = document.querySelector("canvas");

//1. check that the webGPU is supported on the current device
if (!navigator.gpu) 
{
    throw new Error("Whoops, GPU isn't supported on this device!")
    //here we would inform the user, and default to webGL instead
}

//2.now we need to request an ~adapter~ , we can think of this as a specific peice of GPU hardware... like a graphics card.
const adapter = await navigator.gpu.requestAdapter();
if(!adapter) 
{
        throw new Error("No GPUAdapter found, sorry mate");
}

//3. Once we have the adapter, we need to request a GPU Device. which is the main interface where most of the interaction with the GPU happens
const device = await adapter.requestDevice()


// --------------------------------------------------------------

//4. Lets set up the canvas
const context= canvas.getContext("webgpu");
const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
context.configure(
    {
        device: device,
        format: canvasFormat,
    });


//5. Lets send some instructions to the gpu. In order to do that, we need to set up the GPU encoder. which gives us an interface to talk to the gpu
const encoder = device.createCommandEncoder();

//.6 Create a pass
const pass = encoder.beginRenderPass(
{
    colorAttachments:[{
        view: context.getCurrentTexture().createView(),
        loadOp: "clear",  //clear the texture when the render pass starts
        clearValue: [0,0.5,0.7,1],     //set the clear color of the canvas
        storeOp: "store", //store the results back into the texture after the pass
    }]
});


//7. end the pass immediately
pass.end()

//8. Lets create a command buffer. This holds all the commands we've specified above. 
//   We create this buffer by calling the encoder.finish() command
const commandBuffer = encoder.finish();

//.9 Submit your commands to the gpu command queue. this will ensure execution is done correclty and in order
//   Note. once you've submitted a buffer, it cannot be used again
device.queue.submit([commandBuffer]);

//. 8->9  Taking into consideration the above note. We should combine step 8 and 9
//device.queue.submit([encoder.finish()])

//.10 After you submit your commands, you let javascript take the wheel again. if you want to update the canvas contents, you need to record and submit a new buffer, calling context.getCurrentTexture again to get a new texture for a render pass
























