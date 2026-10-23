package com.lovelies.frontend.preview

import org.junit.Assert.*
import org.junit.Test

class SourcePhotoGeometryTest {
    private fun tile(id: Int,x: Float,y: Float,w: Float,h: Float)=SourcePhotoTile(id,"source-crop-$id.jpg",x,y,w,h,
        id%2==0,true,"saved",listOf(.8f,.03f,.15f,.15f),listOf(.8f,.8f,.15f,.15f),true,.9f,.1f,.15f)

    @Test fun alreadyUsableSourceGeometryIsPreservedExactly() {
        val input=listOf(tile(0,0f,0f,.48f,.4f),tile(1,.52f,0f,.48f,.5f))
        assertSame(input,accessibleSourceTiles(input,355f,355f))
    }

    @Test fun sourceFragmentsReflowWithoutOverlapWhileRetainingIdentityAndCropControls() {
        val input=listOf(tile(0,0f,0f,.31f,.5f),tile(1,.33f,0f,.31f,.45f),
            tile(12,0f,.8f,.226f,.0836f),tile(13,.24f,.8f,.23f,.0836f),
            tile(6,.9f,0f,.1f,.55f),tile(4,.7f,.8f,.15f,.073f))
        for(width in listOf(160f,320f,355f)) {
            val height=width*1.15f
            val result=accessibleSourceTiles(input,width,height)
            assertEquals(input.map { it.id },result.map { it.id })
            result.forEachIndexed { index,placed ->
                assertTrue(placed.width*width>=96f-.01f)
                assertTrue(placed.height*height>=96f-.01f)
                assertTrue(placed.x>=0f && placed.x+placed.width<=1.001f)
                assertEquals(input[index],placed.copy(x=input[index].x,y=input[index].y,width=input[index].width,height=input[index].height))
            }
            for(i in result.indices)for(j in i+1 until result.size) {
                val a=result[i];val b=result[j]
                val overlapX=minOf(a.x+a.width,b.x+b.width)-maxOf(a.x,b.x)
                val overlapY=minOf(a.y+a.height,b.y+b.height)-maxOf(a.y,b.y)
                assertFalse("Overlapping photo controls at width $width",overlapX>.0001f && overlapY>.0001f)
            }
        }
        assertSame(input,accessibleSourceTiles(input,720f,828f))
    }
}
