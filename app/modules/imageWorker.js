import { parentPort } from 'worker_threads'

const isColorSimilar = (r, g, b, targetR, targetG, targetB, toleranceR, toleranceG, toleranceB) => {
    return r >= targetR - toleranceR && r <= targetR + toleranceR &&
           g >= targetG - toleranceG && g <= targetG + toleranceG &&
           b >= targetB - toleranceB && b <= targetB + toleranceB
}

parentPort.on('message', ({
    sharedResult,
    maskData,
    start,
    end,
    useMask,
    targetR,
    targetG,
    targetB,
    toleranceR,
    toleranceG,
    toleranceB
}) => {
    const resultView = new Uint8Array(sharedResult)
    const maskView = maskData ? new Uint8Array(maskData) : null

    if (useMask && maskView) {
        for (let i = start; i < end; i += 4) {
            const maskR = maskView[i]
            const maskG = maskView[i + 1]
            const maskB = maskView[i + 2]
            const maskA = maskView[i + 3]

            if (maskA === 255 && isColorSimilar(
                maskR, maskG, maskB,
                targetR, targetG, targetB,
                toleranceR, toleranceG, toleranceB
            )) {
                resultView[i + 3] = 0
            }
        }
    } else {
        for (let i = start; i < end; i += 4) {
            const sourceA = resultView[i + 3]
            if (sourceA === 255) {
                const sourceR = resultView[i]
                const sourceG = resultView[i + 1]
                const sourceB = resultView[i + 2]

                if (isColorSimilar(
                    sourceR, sourceG, sourceB,
                    targetR, targetG, targetB,
                    toleranceR, toleranceG, toleranceB
                )) {
                    resultView[i + 3] = 0
                }
            }
        }
    }

    parentPort.postMessage('done')
})