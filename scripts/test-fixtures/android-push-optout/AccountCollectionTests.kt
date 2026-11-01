package com.lovelies.frontend.preview

private fun listId(index:Int)="00000000-0000-4000-8000-${index.toString().padStart(12,'0')}"
private fun listPage(rows:List<WireObject>,next:String?,total:Int=rows.size)=mapOf("items" to rows,
    "page" to mapOf("limit" to 100,"total" to total,"next_cursor" to next))
fun runAccountCollectionChecks(run:(String,()->Unit)->Unit) {
    run("account collections load beyond 100 while preserving IDs and current row updates") {
        val first=(1..100).map { mapOf("id" to listId(it),"status" to "old") }
        val one=AccountCollectionPage.parse(listPage(first,"cursor-100",101))
        val two=AccountCollectionPage.parse(listPage(listOf(mapOf("id" to listId(100),"status" to "new"),mapOf("id" to listId(101))),null,101),requested=one.nextCursor)
        val combined=two.appending(one.items)
        check(combined.size==101 && combined.map { it["id"] }.toSet().size==101)
        check(combined[99]["status"]=="new" && two.nextCursor==null)
    }
    run("account collection requests explicitly ask for 100 and preserve opaque cursor bytes") {
        val cursor="opaque+cursor/with=padding"
        check(AccountCollectionPage.request(null)==mapOf("limit" to 100))
        check(AccountCollectionPage.request(cursor)==mapOf("limit" to 100,"cursor" to cursor))
        val path=AccountCollectionPage.path("/me/notifications",cursor)
        check(path.startsWith("/me/notifications?limit=100&cursor="))
        check(java.net.URLDecoder.decode(path.substringAfter("&cursor="),"UTF-8")==cursor)
    }
    run("account collection continuation rejects duplicate IDs empty continuing pages and cursor cycles") {
        val row=mapOf("id" to listId(1))
        check(runCatching { AccountCollectionPage.parse(listPage(listOf(row,row),null)) }.isFailure)
        check(runCatching { AccountCollectionPage.parse(listPage(emptyList(),"next")) }.isFailure)
        check(runCatching { AccountCollectionPage.parse(listPage(listOf(row),"same"),requested="same") }.isFailure)
        check(runCatching { AccountCollectionPage.parse(listPage(listOf(row),"old"),requested="new",seen=setOf("old")) }.isFailure)
        check(AccountCollectionPage.parse(listPage(emptyList(),null)).items.isEmpty())
    }
    run("account collection fences reject late old-account and old-epoch replies and discard old cursors on reset") {
        val a=SessionScope(1,listId(1));val b=SessionScope(2,listId(2))
        val request=AccountCollectionRequest.create(a,"cursor",a.accountId,false)
        request.assertCurrent(a)
        check(runCatching { request.assertCurrent(a.copy(epoch=2)) }.isFailure)
        check(runCatching { request.assertCurrent(b) }.isFailure)
        check(runCatching { AccountCollectionRequest.create(b,"cursor",a.accountId,false) }.isFailure)
        check(AccountCollectionRequest.create(b,"cursor",a.accountId,true).cursor==null)
    }
    run("account collection metadata cannot silently truncate default pages or misreport continuation") {
        val row=mapOf("id" to listId(1));val good=listPage(listOf(row),null)
        check(runCatching { AccountCollectionPage.parse(good-"page") }.isFailure)
        check(runCatching { AccountCollectionPage.parse(good+mapOf("page" to mapOf("limit" to 25,"total" to 1,"next_cursor" to null))) }.isFailure)
        check(runCatching { AccountCollectionPage.parse(good+mapOf("page" to mapOf("limit" to 100,"total" to 1))) }.isFailure)
        check(runCatching { AccountCollectionPage.parse(good+mapOf("page" to (NativeProtocol.obj(good["page"])+mapOf("has_more" to true)))) }.isFailure)
        check(runCatching { AccountCollectionPage.parse(listPage((1..101).map { mapOf("id" to listId(it)) },null)) }.isFailure)
    }
}
