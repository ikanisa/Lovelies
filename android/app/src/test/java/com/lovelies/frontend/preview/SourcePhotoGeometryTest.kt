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
                assertTrue("Screenshot fragments cannot create unbounded columns",placed.height*height<=maxOf(96f,placed.width*width*2)+.01f)
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

    @Test fun narrowChurchFragmentKeepsOriginalPhotoCenterAndExcludesItsBakedPeopleMarker() {
        val church=SourcePhotoTile(6,"ref26_09.jpg",.379f,.597f,.10045662f,.39344262f,null,true,null,null,
            listOf(.09090909f,.7666667f,.9090909f,.18333334f),false)
        val crop=sourceReflowCrop(church,22,120)
        assertEquals(0f,crop.left,0f);assertEquals(0f,crop.top,0f);assertEquals(1f,crop.right,0f)
        assertEquals(.75f,crop.bottom,.00001f)
        assertTrue(crop.left<=.5f && crop.right>=.5f && crop.top<=.5f && crop.bottom>=.5f)
        assertTrue(crop.bottom<=church.peopleBounds!![1]-2f/120+.00001f)
    }

    @Test fun unmarkedPhotoKeepsEntireSourceAndEdgeMarkerCropRetainsMostPhotography() {
        val original=tile(3,0f,0f,.1f,.5f).copy(controlBounds=null,peopleBounds=null)
        assertEquals(SourcePhotoCrop(),sourceReflowCrop(original,220,120))
        val marked=tile(3,0f,0f,.1f,.5f)
        val crop=sourceReflowCrop(marked,220,120)
        assertTrue(crop.width>0 && crop.height>0 && crop.width*crop.height>=.5f)
        val marker=marked.peopleBounds!!
        assertFalse(crop.left<marker[0]+marker[2] && crop.right>marker[0] &&
            crop.top<marker[1]+marker[3] && crop.bottom>marker[1])
    }

    @Test fun latentAliasSharesOnlyMarkerGeometryOfExactImageBytes() {
        val known=tile(9,0f,0f,.23f,.27f).copy(asset="ref21_10.jpg")
        val latent=known.copy(id=15,asset="ref21_16.jpg",y=1f,height=.087f,sourceSelected=true,controlBounds=null,peopleBounds=null)
        val unrelated=latent.copy(id=16,asset="different-photo.jpg")
        val aliases=sourceMarkerAliases(listOf(known,latent,unrelated),mapOf(known.asset to "a".repeat(64),latent.asset to "a".repeat(64),unrelated.asset to "b".repeat(64)))
        assertEquals(sourceReflowCrop(known,55,65),sourceReflowCrop(latent,55,65,aliases[latent.asset].orEmpty()))
        assertEquals(SourcePhotoCrop(),sourceReflowCrop(unrelated,55,65,aliases[unrelated.asset].orEmpty()))
        assertEquals(15,latent.id);assertEquals("ref21_16.jpg",latent.asset);assertEquals(true,latent.sourceSelected)
    }
}
