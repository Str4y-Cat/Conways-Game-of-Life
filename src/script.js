/**
 * This is an attempt at conways game of life, using webGPU.
 * https://codelabs.developers.google.com/your-first-webgpu-app 
 *
 */ 

// ---------------------------------------
// CONSTANTS 
// ---------------------------------------

const GRID_SIZE = 128;
const WORKGROUP_SIZE= 8;

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


//create a uniform buffer that descibes the grid
const uniformArray = new Float32Array([GRID_SIZE, GRID_SIZE])
const uniformBuffer = device.createBuffer({
    label: "Grid Uniforms",
    size: uniformArray.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(uniformBuffer, 0, uniformArray)

//create a storage buffer for the cell state
//------------------------------------------

//create an array representing the active state of each cell
const cellStateArray = new Uint32Array(GRID_SIZE*GRID_SIZE);

//create a storage buffer to hold the cell state
//Note we're using a ping pong pattern
const cellStateStorage = [
    device.createBuffer({
        label: "cell state A",
        size: cellStateArray.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }),
    device.createBuffer({
        label: "cell state B",
        size: cellStateArray.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
];


//mark every third cell of the grid as active.
for (let i=0; i<cellStateArray.length; ++i){
    cellStateArray[i] = Math.random() > 0.6? 1:0;
}
console.log(cellStateArray)

device.queue.writeBuffer(cellStateStorage[0], 0 , cellStateArray);
device.queue.writeBuffer(cellStateStorage[1], 0 , cellStateArray);


//-------------------------------------------------------------
// DRAWING THE GEOMETRY
//-------------------------------------------------------------

//1. set up the clip space verticies
const vertices = new Float32Array([
//   X,    Y,
  -1.0, -1.0, // Triangle 1 (Blue)
   1.0, -1.0,
   1.0,  1.0,

  -1.0, -1.0, // Triangle 2 (Red)
   1.0,  1.0,
  -1.0,  1.0,
])

//2. create a buffer to hold the verticies
const vertexBuffer = device.createBuffer({
    label: "Cell vertices", //labes are used in error messages
    size: vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
})

//3. copu the vertex data into the buffers memory
device.queue.writeBuffer(vertexBuffer, /*buffer offset*/ 0, vertices);

//4. now we have a buffer, cool, but the 'puter doesnt know anything about the data stored
//   so lets give it more information with the GPUVertexBufferLayout dictionary

const vertexBufferLayout = 
{
    arrayStride:8, //number of bytes the gpu need to skip to find the next vertex
    attributes: [{ //individual info encoded into each vertex
        format: "float32x2",  //fpuVertexFormat, in this case 2 float 32 integers
        offset:0,           //how many bytes into the vertex this particular attribute starts(?)
        shaderLocation:0,   //number betweeen 0 - 15, must be unique for every attribute
        }]
};



//5. create the shader
//Note the "-> ..." syntax, represents the return type
const cellShaderModule = device.createShaderModule(
{
    label: "Cell Shader",
    code:   `
                struct VertexInput {
                    @location(0) pos : vec2f,
                    @builtin(instance_index) instance: u32,
                };

                struct VertexOutput {
                    @builtin(position) pos : vec4f,
                    @location(0) cell: vec2f,
                };

                @group(0) @binding(0) var<uniform> grid: vec2f;
                @group(0) @binding(1) var<storage> cellState: array<u32>;

                @vertex
                fn vertexMain(input: VertexInput)  -> 
                    VertexOutput {
                   
                    let i = f32(input.instance);
                    let cell = vec2f(i % grid.x,floor(i / grid.x ));
                    let state = f32(cellState[input.instance]);
                    let cellOffset = cell / grid * 2;
                    let gridPos = (input.pos*state + 1) / grid - 1 + cellOffset;


                    var output: VertexOutput;
                    output.pos = vec4f( gridPos, 0,1);
                    output.cell = cell;
                    return output;  

                }
               

                struct FragInput{
                    @location(0) cell: vec2f,
                };

                @fragment
                fn fragmentMain(input: FragInput) -> @location(0) vec4f {
                    let c = input.cell/grid;
                    return vec4f(c,1-c.x,1); 

                }
            `
});


// ----------------------------------------------------------------
// COMPUTE SHADER

const simulationShaderModule = device.createShaderModule({
    label: "Game of Life simulation shader",
    code:
    `
        @group(0) @binding(0) var<uniform> grid: vec2f; 

        //pingpong storage buffers
        @group(0) @binding(1) var<storage> cellStateIn: array<u32>;
        @group(0) @binding(2) var<storage, read_write> cellStateOut: array<u32>;
        
        fn cellIndex(cell: vec2u) -> u32
        {
            return (cell.y % u32(grid.y)) * u32(grid.x) + (cell.x % u32(grid.x)); //maps from 2d to 1d idex, and allows for wrapping
        }

        fn cellActive(x: u32, y: u32) -> u32{
            return cellStateIn[cellIndex(vec2(x,y))];
        }


        @compute
        @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE})
        fn computeMain(@builtin(global_invocation_id) cell: vec3u) //giid is a three-dim vector that tells you where in the grid of shader invocations you are. i.e (0,0,0),(1,0,0), ... (31,31,0). so you can treat it as the cell index youre going to operate in
        {

            //get count of active neighborrs 
            let activeNeighbors = cellActive(cell.x+1, cell.y+1) +
                                cellActive(cell.x+1, cell.y) +
                                cellActive(cell.x+1, cell.y-1) +
                                cellActive(cell.x, cell.y-1) +
                                cellActive(cell.x-1, cell.y-1) +
                                cellActive(cell.x-1, cell.y) +
                                cellActive(cell.x-1, cell.y+1) +
                                cellActive(cell.x, cell.y+1);

            let i = cellIndex(cell.xy);

            switch activeNeighbors {
                case 2 : {
                    cellStateOut[i] = cellStateIn[i];
                }
                case 3 : {
                    cellStateOut[i] = 1;
                }
                default: {
                    cellStateOut[i] = 0;
                    }
            }




        }`

        
})




// ----------------------------------------------------------------



// create the bind group layout 
const bindGroupLayout = device.createBindGroupLayout({
    label: "Cell Bind Group Layout",
    entries:
    [
        {
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT| GPUShaderStage.COMPUTE,
            buffer: {}
        },
        {
            binding: 1,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT| GPUShaderStage.COMPUTE,
            buffer: { type: "read-only-storage"}// cell state input buffer
        },
        {
            binding: 2,
            visibility: GPUShaderStage.COMPUTE,
            buffer: {type: "storage"} //cell state output buffer
        }
    ]
});




//set up the bind group for the uniform buffer
const bindGroups =[
    device.createBindGroup({
        label: "Cell renderer bind group A",
        layout: bindGroupLayout, //describes which types of resources this bind group containes
        entries: [
            {
                binding: 0,
                resource: { buffer : uniformBuffer }
            },
            {
                binding: 1,
                resource: { buffer : cellStateStorage[0] }
            },
            {
                binding: 2,
                resource: { buffer : cellStateStorage[1] }
            }

        ],
    }),
    device.createBindGroup({
        label: "Cell renderer bind group B",
        layout: bindGroupLayout, //describes which types of resources this bind group containes
        entries: [
            {
                binding: 0,
                resource: { buffer : uniformBuffer }
            },
            {
                binding: 1,
                resource: { buffer : cellStateStorage[1] }
            },
            {
                binding: 2,
                resource: { buffer : cellStateStorage[0] }
            }


        ],
    }),
]

//create a gpuPipelineLayout
const pipelineLayout = device.createPipelineLayout({
    layout: "cell Pipeline Layout",
    bindGroupLayouts: [bindGroupLayout],
    });


//6. Finaly, lets create the render pipeline
const cellPipeline = device.createRenderPipeline({
    label: "Cell pipeline",
    layout: pipelineLayout,             //describes what types of inputs the pipeline needs
    vertex: {
        module: cellShaderModule,
        entryPoint: "vertexMain",
        buffers: [vertexBufferLayout]
    },
    fragment: {
        module: cellShaderModule,
        entryPoint: "fragmentMain",
        targets:[{
            format: canvasFormat
        }]
    }
});


// compute pipeline
 const simulationPipeline = device.createComputePipeline({
    label: "Simulation Pipeline",
    layout: pipelineLayout,
    compute: {
        module: simulationShaderModule,
        entryPoint: "computeMain",
    }
});

//render funciton
function updateGrid()
{

    step++;
    //5. Lets send some instructions to the gpu. In order to do that, we need to set up the GPU encoder. which gives us an interface to talk to the gpu
    const encoder = device.createCommandEncoder();

    const computePass = encoder.beginComputePass();
    computePass.setPipeline(simulationPipeline);
    computePass.setBindGroup(0,bindGroups[step % 2]);
    
    const workgroupCount = Math.ceil(GRID_SIZE / WORKGROUP_SIZE);
    computePass.dispatchWorkgroups(workgroupCount, workgroupCount);
    computePass.end();

    //.6 Create a pass
    const pass = encoder.beginRenderPass(
    {
        colorAttachments:[{
            view: context.getCurrentTexture().createView(),
            loadOp: "clear",  //clear the texture when the render pass starts
            clearValue: [0,0.0,0.4,1],     //set the clear color of the canvas
            storeOp: "store", //store the results back into the texture after the pass
        }]
    });



    // DRAWING GEOMERTRY: 8. draw the square:
    pass.setPipeline(cellPipeline);
    pass.setVertexBuffer(0, vertexBuffer);

    pass.setBindGroup(0, bindGroups[step%2]); //set the uniform bind group, 0 corresponds to @group(0) in the shader code.
    
    pass.draw(vertices.length/2, GRID_SIZE * GRID_SIZE); 

    //7. end the pass immediately
    pass.end()

    //8. Lets create a command buffer. This holds all the commands we've specified above. 
    //   We create this buffer by calling the encoder.finish() command
    //const commandBuffer = encoder.finish();

    //.9 Submit your commands to the gpu command queue. this will ensure execution is done correclty and in order
    //   Note. once you've submitted a buffer, it cannot be used again
    //device.queue.submit([commandBuffer]);

    //. 8->9  Taking into consideration the above note. We should combine step 8 and 9
    device.queue.submit([encoder.finish()])

    //After you submit your commands, you let javascript take the wheel again. if you want to update the canvas contents, you need to record and submit a new buffer, calling context.getCurrentTexture again to get a new texture for a render pass

}
//--------------------------------------------------
// CREATE THE RENDER LOOP
//--------------------------------------------------

const UPDATE_INTERVAL = 200;
let step = 0;

setInterval(updateGrid, UPDATE_INTERVAL);
