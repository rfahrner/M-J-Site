Private Sub Application_ItemSend(ByVal Item As Object, Cancel As Boolean)
    ' Automatically sends any outgoing message addressed to @textbetter.com
    ' through the memPPW@dltransport.com account, regardless of which
    ' account was showing as "From" when the message was composed.
    '
    ' This runs at the moment of send (not when switching the From field
    ' in the compose window), so it does NOT reset or blank out a message
    ' that was pre-filled via a mailto: link -- unlike manually clicking
    ' the From dropdown, which does.

    Const TARGET_ACCOUNT As String = "memPPW@dltransport.com"

    If Not TypeOf Item Is Outlook.MailItem Then Exit Sub

    Dim mail As Outlook.MailItem
    Set mail = Item

    If InStr(1, mail.To, "@textbetter.com", vbTextCompare) = 0 Then Exit Sub

    Dim acc As Outlook.Account
    For Each acc In Application.Session.Accounts
        If StrComp(acc.SmtpAddress, TARGET_ACCOUNT, vbTextCompare) = 0 Then
            Set mail.SendUsingAccount = acc
            Exit For
        End If
    Next acc
End Sub
